// sk-capture.exe — SoundKami's tiny Windows audio helper.
//
//   sk-capture list
//       Prints a JSON array of apps that currently own an audio session
//       (Spotify, browsers, games...). Used for the "Share music" picker.
//
//   sk-capture capture <pid> [include|exclude]
//       Captures the audio of one process tree using the Windows 10 (2004+)
//       process-loopback API and streams raw PCM (s16le, stereo) to stdout.
//       The first line on stderr is "FORMAT <rate> <channels> <bits>".
//       Exits when stdin is closed (i.e. when SoundKami quits).
//
// Builds with MinGW-w64 or MSVC. No third-party dependencies.

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <objbase.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <audiopolicy.h>
#include <propidl.h>
#include <tlhelp32.h>
#include <string>
#include <vector>
#include <map>
#include <cstdio>
#include <cwchar>

// ---------------------------------------------------------------------------
// GUIDs (defined locally so the file links the same way with MinGW and MSVC)
// ---------------------------------------------------------------------------
static const GUID kCLSID_MMDeviceEnumerator = {0xBCDE0395, 0xE52F, 0x467C, {0x8E, 0x3D, 0xC4, 0x57, 0x92, 0x91, 0x69, 0x2E}};
static const GUID kIID_IMMDeviceEnumerator  = {0xA95664D2, 0x9614, 0x4F35, {0xA7, 0x46, 0xDE, 0x8D, 0xB6, 0x36, 0x17, 0xE6}};
static const GUID kIID_IAudioClient         = {0x1CB9AD4C, 0xDBFA, 0x4C32, {0xB1, 0x78, 0xC2, 0xF5, 0x68, 0xA7, 0x03, 0xB2}};
static const GUID kIID_IAudioCaptureClient  = {0xC8ADBD64, 0xE71E, 0x48A0, {0xA4, 0xDE, 0x18, 0x5C, 0x39, 0x5C, 0xD3, 0x17}};
static const GUID kIID_IAudioSessionManager2 = {0x77AA99A0, 0x1BD6, 0x484F, {0x8B, 0xC7, 0x2C, 0x65, 0x4C, 0x9A, 0x9B, 0x6F}};
static const GUID kIID_IAudioSessionControl2 = {0xBFB7FF88, 0x7239, 0x4FC9, {0x8F, 0xA2, 0x07, 0xC9, 0x50, 0xBE, 0x9C, 0x6D}};
static const GUID kIID_IActivateAudioInterfaceCompletionHandler = {0x41D949AB, 0x9862, 0x444A, {0x80, 0xF6, 0xC2, 0x61, 0x33, 0x4D, 0xA5, 0xEB}};
static const GUID kIID_IAgileObject         = {0x94EA2B94, 0xE9CC, 0x49E0, {0xC0, 0xFF, 0xEE, 0x64, 0xCA, 0x8F, 0x5B, 0x90}};
static const GUID kIID_IUnknown             = {0x00000000, 0x0000, 0x0000, {0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46}};

// ---------------------------------------------------------------------------
// Process-loopback activation structures (audioclientactivationparams.h).
// Declared here because older SDK / MinGW headers don't ship them.
// ---------------------------------------------------------------------------
enum SK_AUDIOCLIENT_ACTIVATION_TYPE { SK_ACTIVATION_TYPE_DEFAULT = 0, SK_ACTIVATION_TYPE_PROCESS_LOOPBACK = 1 };
enum SK_PROCESS_LOOPBACK_MODE { SK_LOOPBACK_INCLUDE_TREE = 0, SK_LOOPBACK_EXCLUDE_TREE = 1 };
struct SK_PROCESS_LOOPBACK_PARAMS { DWORD TargetProcessId; SK_PROCESS_LOOPBACK_MODE ProcessLoopbackMode; };
struct SK_AUDIOCLIENT_ACTIVATION_PARAMS { SK_AUDIOCLIENT_ACTIVATION_TYPE ActivationType; SK_PROCESS_LOOPBACK_PARAMS ProcessLoopbackParams; };
static const wchar_t* kVirtualLoopbackDevice = L"VAD\\Process_Loopback";

#ifndef AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
#define AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM 0x80000000
#endif
#ifndef AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY
#define AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY 0x08000000
#endif

template <class T> static void SafeRelease(T*& p) { if (p) { p->Release(); p = nullptr; } }

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
static std::string Utf8(const std::wstring& w) {
    if (w.empty()) return std::string();
    int n = WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), nullptr, 0, nullptr, nullptr);
    std::string s(n, '\0');
    WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), &s[0], n, nullptr, nullptr);
    return s;
}

static std::string JsonEscape(const std::string& s) {
    std::string o;
    o.reserve(s.size() + 8);
    for (unsigned char c : s) {
        switch (c) {
            case '"': o += "\\\""; break;
            case '\\': o += "\\\\"; break;
            case '\n': o += "\\n"; break;
            case '\r': o += "\\r"; break;
            case '\t': o += "\\t"; break;
            default:
                if (c < 0x20) { char b[8]; snprintf(b, sizeof b, "\\u%04x", c); o += b; }
                else o += (char)c;
        }
    }
    return o;
}

static std::wstring ProcessPath(DWORD pid) {
    std::wstring out;
    HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!h) return out;
    wchar_t buf[MAX_PATH * 2];
    DWORD len = (DWORD)(sizeof(buf) / sizeof(buf[0]));
    if (QueryFullProcessImageNameW(h, 0, buf, &len)) out.assign(buf, len);
    CloseHandle(h);
    return out;
}

static std::wstring BaseName(const std::wstring& path) {
    size_t p = path.find_last_of(L"\\/");
    return p == std::wstring::npos ? path : path.substr(p + 1);
}

static std::wstring FileDescription(const std::wstring& path) {
    DWORD dummy = 0;
    DWORD size = GetFileVersionInfoSizeW(path.c_str(), &dummy);
    if (!size) return L"";
    std::vector<BYTE> data(size);
    if (!GetFileVersionInfoW(path.c_str(), 0, size, data.data())) return L"";
    struct LangCp { WORD lang; WORD cp; } *trans = nullptr;
    UINT tlen = 0;
    if (!VerQueryValueW(data.data(), L"\\VarFileInfo\\Translation", (void**)&trans, &tlen) || tlen < sizeof(LangCp)) return L"";
    wchar_t key[128];
    swprintf(key, 128, L"\\StringFileInfo\\%04x%04x\\FileDescription", trans[0].lang, trans[0].cp);
    wchar_t* val = nullptr;
    UINT vlen = 0;
    if (VerQueryValueW(data.data(), key, (void**)&val, &vlen) && val && vlen > 1) return std::wstring(val);
    return L"";
}

// Walk up the parent chain while the parent runs the same executable, so that
// multi-process apps (Chrome, Spotify, Edge...) are captured as a whole tree.
static DWORD RootOfSameApp(DWORD pid, const std::map<DWORD, std::pair<DWORD, std::wstring>>& procs) {
    auto it = procs.find(pid);
    if (it == procs.end()) return pid;
    const std::wstring exe = it->second.second;
    DWORD cur = pid;
    for (int guard = 0; guard < 32; ++guard) {
        auto c = procs.find(cur);
        if (c == procs.end()) break;
        DWORD parent = c->second.first;
        auto p = procs.find(parent);
        if (p == procs.end() || parent == cur) break;
        if (_wcsicmp(p->second.second.c_str(), exe.c_str()) != 0) break;
        cur = parent;
    }
    return cur;
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------
static int CmdList() {
    // Snapshot of every process: pid -> (parentPid, exeName)
    std::map<DWORD, std::pair<DWORD, std::wstring>> procs;
    HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snap != INVALID_HANDLE_VALUE) {
        PROCESSENTRY32W pe;
        pe.dwSize = sizeof(pe);
        if (Process32FirstW(snap, &pe)) {
            do { procs[pe.th32ProcessID] = std::make_pair(pe.th32ParentProcessID, std::wstring(pe.szExeFile)); }
            while (Process32NextW(snap, &pe));
        }
        CloseHandle(snap);
    }

    struct Entry { DWORD pid; DWORD root; bool active; };
    std::map<DWORD, Entry> found;

    IMMDeviceEnumerator* enumr = nullptr;
    HRESULT hr = CoCreateInstance(kCLSID_MMDeviceEnumerator, nullptr, CLSCTX_ALL, kIID_IMMDeviceEnumerator, (void**)&enumr);
    if (FAILED(hr)) { fprintf(stderr, "enumerator failed 0x%08lx\n", (unsigned long)hr); printf("[]\n"); return 1; }

    IMMDeviceCollection* devices = nullptr;
    if (SUCCEEDED(enumr->EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, &devices))) {
        UINT count = 0;
        devices->GetCount(&count);
        for (UINT d = 0; d < count; ++d) {
            IMMDevice* dev = nullptr;
            if (FAILED(devices->Item(d, &dev))) continue;
            IAudioSessionManager2* mgr = nullptr;
            if (SUCCEEDED(dev->Activate(kIID_IAudioSessionManager2, CLSCTX_ALL, nullptr, (void**)&mgr))) {
                IAudioSessionEnumerator* sessions = nullptr;
                if (SUCCEEDED(mgr->GetSessionEnumerator(&sessions))) {
                    int n = 0;
                    sessions->GetCount(&n);
                    for (int i = 0; i < n; ++i) {
                        IAudioSessionControl* ctl = nullptr;
                        if (FAILED(sessions->GetSession(i, &ctl))) continue;
                        IAudioSessionControl2* ctl2 = nullptr;
                        if (SUCCEEDED(ctl->QueryInterface(kIID_IAudioSessionControl2, (void**)&ctl2))) {
                            DWORD pid = 0;
                            AudioSessionState state = AudioSessionStateInactive;
                            ctl->GetState(&state);
                            bool system = ctl2->IsSystemSoundsSession() == S_OK;
                            if (SUCCEEDED(ctl2->GetProcessId(&pid)) && pid != 0 && !system) {
                                DWORD root = RootOfSameApp(pid, procs);
                                auto& e = found[root];
                                e.pid = pid;
                                e.root = root;
                                e.active = e.active || state == AudioSessionStateActive;
                            }
                            SafeRelease(ctl2);
                        }
                        SafeRelease(ctl);
                    }
                    SafeRelease(sessions);
                }
                SafeRelease(mgr);
            }
            SafeRelease(dev);
        }
        SafeRelease(devices);
    }
    SafeRelease(enumr);

    std::string out = "[";
    bool first = true;
    for (auto& kv : found) {
        const Entry& e = kv.second;
        std::wstring path = ProcessPath(e.root);
        if (path.empty()) path = ProcessPath(e.pid);
        std::wstring exe = path.empty() ? (procs.count(e.root) ? procs[e.root].second : L"") : BaseName(path);
        std::wstring name = path.empty() ? L"" : FileDescription(path);
        if (name.empty()) {
            name = exe;
            size_t dot = name.find_last_of(L'.');
            if (dot != std::wstring::npos) name = name.substr(0, dot);
        }
        char num[64];
        if (!first) out += ",";
        first = false;
        out += "{\"pid\":";
        snprintf(num, sizeof num, "%lu", (unsigned long)e.pid); out += num;
        out += ",\"rootPid\":";
        snprintf(num, sizeof num, "%lu", (unsigned long)e.root); out += num;
        out += ",\"exe\":\"" + JsonEscape(Utf8(exe)) + "\"";
        out += ",\"name\":\"" + JsonEscape(Utf8(name)) + "\"";
        out += ",\"path\":\"" + JsonEscape(Utf8(path)) + "\"";
        out += std::string(",\"active\":") + (e.active ? "true" : "false") + "}";
    }
    out += "]\n";
    fwrite(out.data(), 1, out.size(), stdout);
    fflush(stdout);
    return 0;
}

// ---------------------------------------------------------------------------
// capture
// ---------------------------------------------------------------------------
class ActivationHandler : public IActivateAudioInterfaceCompletionHandler {
public:
    ActivationHandler() : done_(nullptr), result_(E_FAIL), client_(nullptr), refs_(1) {
        done_ = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    }
    virtual ~ActivationHandler() { if (done_) CloseHandle(done_); }

    // IUnknown
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** ppv) override {
        if (!ppv) return E_POINTER;
        if (IsEqualGUID(riid, kIID_IUnknown) || IsEqualGUID(riid, kIID_IActivateAudioInterfaceCompletionHandler) ||
            IsEqualGUID(riid, kIID_IAgileObject)) {
            *ppv = static_cast<IActivateAudioInterfaceCompletionHandler*>(this);
            AddRef();
            return S_OK;
        }
        *ppv = nullptr;
        return E_NOINTERFACE;
    }
    ULONG STDMETHODCALLTYPE AddRef() override { return (ULONG)InterlockedIncrement(&refs_); }
    ULONG STDMETHODCALLTYPE Release() override {
        LONG r = InterlockedDecrement(&refs_);
        if (r == 0) delete this;
        return (ULONG)r;
    }

    // IActivateAudioInterfaceCompletionHandler
    HRESULT STDMETHODCALLTYPE ActivateCompleted(IActivateAudioInterfaceAsyncOperation* op) override {
        HRESULT activateHr = E_FAIL;
        IUnknown* unk = nullptr;
        HRESULT hr = op->GetActivateResult(&activateHr, &unk);
        if (SUCCEEDED(hr) && SUCCEEDED(activateHr) && unk) {
            hr = unk->QueryInterface(kIID_IAudioClient, (void**)&client_);
        } else {
            hr = FAILED(hr) ? hr : activateHr;
        }
        if (unk) unk->Release();
        result_ = hr;
        SetEvent(done_);
        return S_OK;
    }

    HANDLE done_;
    HRESULT result_;
    IAudioClient* client_;

private:
    volatile LONG refs_;
};

static void Fail(const char* what, HRESULT hr) {
    fprintf(stderr, "ERROR %s 0x%08lx\n", what, (unsigned long)hr);
    fflush(stderr);
}

static DWORD WINAPI StdinWatchdog(LPVOID) {
    // When SoundKami exits (or kills us) the pipe closes and ReadFile fails.
    HANDLE in = GetStdHandle(STD_INPUT_HANDLE);
    char buf[64];
    DWORD got = 0;
    while (ReadFile(in, buf, sizeof buf, &got, nullptr) && got > 0) {}
    ExitProcess(0);
    return 0;
}

static IAudioClient* ActivateLoopback(DWORD pid, bool include) {
    SK_AUDIOCLIENT_ACTIVATION_PARAMS params = {};
    params.ActivationType = SK_ACTIVATION_TYPE_PROCESS_LOOPBACK;
    params.ProcessLoopbackParams.TargetProcessId = pid;
    params.ProcessLoopbackParams.ProcessLoopbackMode = include ? SK_LOOPBACK_INCLUDE_TREE : SK_LOOPBACK_EXCLUDE_TREE;

    PROPVARIANT pv;
    PropVariantInit(&pv);
    pv.vt = VT_BLOB;
    pv.blob.cbSize = sizeof(params);
    pv.blob.pBlobData = reinterpret_cast<BYTE*>(&params);

    ActivationHandler* handler = new ActivationHandler();
    IActivateAudioInterfaceAsyncOperation* op = nullptr;
    // Resolved at runtime so the helper still starts (and "list" works) on
    // Windows builds that predate process loopback.
    typedef HRESULT (WINAPI *ActivateFn)(LPCWSTR, REFIID, PROPVARIANT*, IActivateAudioInterfaceCompletionHandler*, IActivateAudioInterfaceAsyncOperation**);
    static ActivateFn activate = nullptr;
    if (!activate) {
        HMODULE mod = LoadLibraryW(L"mmdevapi.dll");
        if (mod) activate = (ActivateFn)(void*)GetProcAddress(mod, "ActivateAudioInterfaceAsync");
    }
    if (!activate) { Fail("unsupported", E_NOTIMPL); handler->Release(); return nullptr; }
    HRESULT hr = activate(kVirtualLoopbackDevice, kIID_IAudioClient, &pv, handler, &op);
    if (FAILED(hr)) {
        Fail("activate", hr);
        handler->Release();
        return nullptr;
    }
    WaitForSingleObject(handler->done_, 10000);
    IAudioClient* client = handler->client_;
    if (FAILED(handler->result_) || !client) {
        Fail("activate-result", handler->result_);
        client = nullptr;
    }
    SafeRelease(op);
    handler->Release();
    return client;
}

static int CmdCapture(DWORD pid, bool include) {
    HANDLE out = GetStdHandle(STD_OUTPUT_HANDLE);
    CreateThread(nullptr, 0, StdinWatchdog, nullptr, 0, nullptr);

    // Try a few formats; the process-loopback virtual device converts for us.
    const DWORD rates[] = {48000, 44100};
    const DWORD flagSets[] = {
        AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
        AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
    };

    IAudioClient* client = nullptr;
    WAVEFORMATEX fmt = {};
    HRESULT hr = E_FAIL;
    bool ok = false;
    for (DWORD rate : rates) {
        for (DWORD flags : flagSets) {
            client = ActivateLoopback(pid, include);
            if (!client) return 2;
            fmt.wFormatTag = WAVE_FORMAT_PCM;
            fmt.nChannels = 2;
            fmt.nSamplesPerSec = rate;
            fmt.wBitsPerSample = 16;
            fmt.nBlockAlign = fmt.nChannels * fmt.wBitsPerSample / 8;
            fmt.nAvgBytesPerSec = fmt.nSamplesPerSec * fmt.nBlockAlign;
            fmt.cbSize = 0;
            hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED, flags, 200000 /* 20 ms */, 0, &fmt, nullptr);
            if (SUCCEEDED(hr)) { ok = true; break; }
            SafeRelease(client);
        }
        if (ok) break;
    }
    if (!ok) { Fail("initialize", hr); return 3; }

    HANDLE evt = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    hr = client->SetEventHandle(evt);
    if (FAILED(hr)) { Fail("event", hr); return 4; }

    IAudioCaptureClient* cap = nullptr;
    hr = client->GetService(kIID_IAudioCaptureClient, (void**)&cap);
    if (FAILED(hr)) { Fail("service", hr); return 5; }

    fprintf(stderr, "FORMAT %lu %u %u\n", (unsigned long)fmt.nSamplesPerSec, fmt.nChannels, fmt.wBitsPerSample);
    fflush(stderr);

    hr = client->Start();
    if (FAILED(hr)) { Fail("start", hr); return 6; }

    std::vector<BYTE> zeros;
    const UINT32 block = fmt.nBlockAlign;
    for (;;) {
        WaitForSingleObject(evt, 200);
        UINT32 packet = 0;
        while (SUCCEEDED(cap->GetNextPacketSize(&packet)) && packet > 0) {
            BYTE* data = nullptr;
            UINT32 frames = 0;
            DWORD flags = 0;
            hr = cap->GetBuffer(&data, &frames, &flags, nullptr, nullptr);
            if (FAILED(hr)) { Fail("getbuffer", hr); return 7; }
            DWORD bytes = frames * block;
            const BYTE* src = data;
            if (flags & AUDCLNT_BUFFERFLAGS_SILENT) {
                if (zeros.size() < bytes) zeros.assign(bytes, 0);
                src = zeros.data();
            }
            DWORD written = 0;
            BOOL wok = bytes == 0 || WriteFile(out, src, bytes, &written, nullptr);
            cap->ReleaseBuffer(frames);
            if (!wok) return 0;  // parent went away
        }
    }
}

// ---------------------------------------------------------------------------
int wmain(int argc, wchar_t** argv) {
    HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (FAILED(hr)) { Fail("coinit", hr); return 1; }

    if (argc >= 2 && _wcsicmp(argv[1], L"list") == 0) return CmdList();

    if (argc >= 3 && _wcsicmp(argv[1], L"capture") == 0) {
        DWORD pid = (DWORD)_wtoi(argv[2]);
        bool include = !(argc >= 4 && _wcsicmp(argv[3], L"exclude") == 0);
        return CmdCapture(pid, include);
    }

    fprintf(stderr, "usage: sk-capture list | sk-capture capture <pid> [include|exclude]\n");
    return 1;
}
