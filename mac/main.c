// Push Surface — native macOS app: a small status window around the NT·Push engine.
//
// Written in plain C against the Objective-C runtime so it can be cross-compiled without the macOS SDK:
//   zig cc -target aarch64-macos -O2 -o "Push Surface" mac/main.c
// AppKit and WebKit are loaded at run time; every Objective-C call goes through objc_msgSend cast to
// its exact signature (required on arm64).
//
// The engine (src/ipc.js) runs on the installed Node.js and talks to this window over stdin/stdout.

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdbool.h>
#include <unistd.h>
#include <fcntl.h>
#include <dlfcn.h>
#include <dirent.h>
#include <signal.h>
#include <pthread.h>
#include <spawn.h>
#include <sys/wait.h>
#include <sys/stat.h>
#include <mach-o/dyld.h>

extern char **environ;

// ---- Objective-C runtime, resolved at run time ---------------------------------------------
typedef void *id;
typedef void *SEL;
typedef void *Class;
typedef struct { double x, y, w, h; } Rect;

static id (*getClass)(const char *);
static SEL (*selName)(const char *);
static Class (*allocClassPair)(Class, const char *, size_t);
static void (*registerClassPair)(Class);
static bool (*addMethod)(Class, SEL, void *, const char *);
static void *(*getProtocol)(const char *);
static bool (*addProtocol)(Class, void *);
static void *msgSend;

#define C(name) getClass(name)
#define S(name) selName(name)
// objc_msgSend cast to a concrete signature: MSG(return type, arg types...)(receiver, selector, args...)
#define MSG(ret, ...) ((ret (*)(id, SEL, ##__VA_ARGS__))msgSend)

static id str(const char *s) { return MSG(id, const char *)(C("NSString"), S("stringWithUTF8String:"), s); }
static const char *cstr(id s) { return s ? MSG(const char *)(s, S("UTF8String")) : NULL; }
static id alloc_init(const char *cls) { return MSG(id)(MSG(id)(C(cls), S("alloc")), S("init")); }

// ---- libdispatch (part of libSystem) -------------------------------------------------------
static void (*dispatchAsync)(void *queue, void *ctx, void (*fn)(void *));
static void *mainQueue;
static void on_main(void *ctx, void (*fn)(void *)) { dispatchAsync(mainQueue, ctx, fn); }

// ---- app state --------------------------------------------------------------------------------
static id app, window, web;
static char resources[4096], appDir[4096], logPath[4096], configPath[4096];
static bool pageReady = false, quitting = false;
static char **pending = NULL; static int pendingCount = 0, pendingCap = 0;
static int engineIn = -1, engineOut = -1;
static pid_t enginePid = 0;
static const double WIDTH = 440;

static void alert(const char *title, const char *text, const char *button2, const char *openURL) {
    id a = alloc_init("NSAlert");
    MSG(void, id)(a, S("setMessageText:"), str(title));
    MSG(void, id)(a, S("setInformativeText:"), str(text));
    if (button2) MSG(id, id)(a, S("addButtonWithTitle:"), str(button2));
    MSG(id, id)(a, S("addButtonWithTitle:"), str("OK"));
    long r = MSG(long)(a, S("runModal"));
    if (button2 && r == 1000 && openURL) {
        id url = strncmp(openURL, "http", 4) == 0 ? MSG(id, id)(C("NSURL"), S("URLWithString:"), str(openURL))
                                                  : MSG(id, id)(C("NSURL"), S("fileURLWithPath:"), str(openURL));
        MSG(bool, id)(MSG(id)(C("NSWorkspace"), S("sharedWorkspace")), S("openURL:"), url);
    }
}

// ---- web page bridge ----------------------------------------------------------------------
static void run_js(const char *js) {
    MSG(void, id, void *)(web, S("evaluateJavaScript:completionHandler:"), str(js), NULL);
}

// one JSON line from the engine → window.__ntpush(type, data)
static void deliver_line(void *ctx) {
    char *line = ctx;
    const char *cfg = "{\"type\":\"config\",\"data\":\"";
    if (strncmp(line, cfg, strlen(cfg)) == 0) {
        const char *p = line + strlen(cfg);
        const char *q = strchr(p, '"');
        if (q && (size_t)(q - p) < sizeof configPath) { memcpy(configPath, p, q - p); configPath[q - p] = 0; }
        free(line);
        return;
    }
    size_t n = strlen(line) + 96;
    char *js = malloc(n);
    snprintf(js, n, "(function (m) { window.__ntpush(m.type, m.data); })(%s);", line);
    free(line);
    if (pageReady) { run_js(js); free(js); return; }
    if (pendingCount == pendingCap) { pendingCap = pendingCap ? pendingCap * 2 : 64; pending = realloc(pending, pendingCap * sizeof *pending); }
    pending[pendingCount++] = js;
}

static void engine_ended(void *ctx) {
    (void)ctx;
    enginePid = 0;
    if (quitting) return;
    alert("Push Surface", "The Push Surface engine stopped. Details are in ~/Library/Logs/Push Surface.log.", "Show log", logPath);
}

static void *reader(void *arg) {
    (void)arg;
    char buf[65536]; size_t len = 0;
    for (;;) {
        ssize_t r = read(engineOut, buf + len, sizeof buf - len - 1);
        if (r <= 0) break;
        len += (size_t)r;
        char *start = buf, *nl;
        while ((nl = memchr(start, '\n', len - (size_t)(start - buf)))) {
            *nl = 0;
            if (nl > start) on_main(strdup(start), deliver_line);
            start = nl + 1;
        }
        len -= (size_t)(start - buf);
        memmove(buf, start, len);
        if (len >= sizeof buf - 1) len = 0; // absurdly long line: drop it
    }
    on_main(NULL, engine_ended);
    return NULL;
}

static void send_cmd(const char *json) {
    if (engineIn < 0) return;
    size_t n = strlen(json);
    if (write(engineIn, json, n) < 0 || write(engineIn, "\n", 1) < 0) { /* engine gone */ }
}

// ---- engine process ---------------------------------------------------------------------
static bool executable(const char *p) { struct stat st; return stat(p, &st) == 0 && (st.st_mode & S_IXUSR) && S_ISREG(st.st_mode); }

static bool find_node(char *out, size_t cap) {
    const char *home = getenv("HOME");
    char p[4096];
    const char *fixed[] = { "/opt/homebrew/bin/node", "/usr/local/bin/node", NULL };
    for (int i = 0; fixed[i]; i++) if (executable(fixed[i])) { snprintf(out, cap, "%s", fixed[i]); return true; }
    if (home) {
        snprintf(p, sizeof p, "%s/.volta/bin/node", home);
        if (executable(p)) { snprintf(out, cap, "%s", p); return true; }
        // newest nvm install
        char dir[4096]; snprintf(dir, sizeof dir, "%s/.nvm/versions/node", home);
        DIR *d = opendir(dir);
        if (d) {
            struct dirent *e; char best[256] = ""; int bm = -1, bn = -1, bp = -1;
            while ((e = readdir(d))) {
                int a, b, c;
                if (sscanf(e->d_name, "v%d.%d.%d", &a, &b, &c) == 3 && (a > bm || (a == bm && (b > bn || (b == bn && c > bp))))) {
                    bm = a; bn = b; bp = c; snprintf(best, sizeof best, "%s", e->d_name);
                }
            }
            closedir(d);
            if (bm >= 0) { snprintf(p, sizeof p, "%s/%s/bin/node", dir, best); if (executable(p)) { snprintf(out, cap, "%s", p); return true; } }
        }
    }
    // whatever a login shell finds
    FILE *f = popen("/bin/zsh -lc 'command -v node' 2>/dev/null", "r");
    if (f) {
        if (fgets(p, sizeof p, f)) { p[strcspn(p, "\r\n")] = 0; if (executable(p)) { pclose(f); snprintf(out, cap, "%s", p); return true; } }
        pclose(f);
    }
    return false;
}

// Files copied out of a downloaded disk image carry a quarantine flag; Node would refuse to load the
// bundled MIDI/USB/graphics modules. Once you've opened the app, clear the flag from its own folder.
static void clear_quarantine(void) {
    id bundle = MSG(id)(C("NSBundle"), S("mainBundle"));
    const char *path = cstr(MSG(id)(bundle, S("bundlePath")));
    if (!path) return;
    pid_t pid; int st;
    char *argv[] = { "/usr/bin/xattr", "-dr", "com.apple.quarantine", (char *)path, NULL };
    if (posix_spawn(&pid, "/usr/bin/xattr", NULL, NULL, argv, environ) == 0) waitpid(pid, &st, 0);
}

static void start_engine(void) {
    char node[4096];
    clear_quarantine();
    if (!find_node(node, sizeof node)) {
        alert("Push Surface needs Node.js", "Install it with Homebrew (brew install node) or from nodejs.org, then open Push Surface again.", "Open nodejs.org", "https://nodejs.org/en/download");
        MSG(void, id)(app, S("terminate:"), NULL);
        return;
    }
    int toEngine[2], fromEngine[2];
    if (pipe(toEngine) || pipe(fromEngine)) { alert("Push Surface", "Couldn't start the engine (pipe).", NULL, NULL); return; }
    int logFd = open(logPath, O_WRONLY | O_CREAT | O_APPEND, 0644);

    posix_spawn_file_actions_t fa;
    posix_spawn_file_actions_init(&fa);
    posix_spawn_file_actions_adddup2(&fa, toEngine[0], 0);
    posix_spawn_file_actions_adddup2(&fa, fromEngine[1], 1);
    if (logFd >= 0) posix_spawn_file_actions_adddup2(&fa, logFd, 2);
    posix_spawn_file_actions_addclose(&fa, toEngine[1]);
    posix_spawn_file_actions_addclose(&fa, fromEngine[0]);

    // PATH: put node's folder first (apps don't inherit the Terminal's PATH)
    char nodeDir[4096]; snprintf(nodeDir, sizeof nodeDir, "%s", node);
    char *slash = strrchr(nodeDir, '/'); if (slash) *slash = 0;
    int n = 0; while (environ[n]) n++;
    char **env = calloc(n + 2, sizeof *env); int k = 0; bool hadPath = false;
    static char pathVar[8192];
    for (int i = 0; i < n; i++) {
        if (strncmp(environ[i], "PATH=", 5) == 0) { snprintf(pathVar, sizeof pathVar, "PATH=%s:%s", nodeDir, environ[i] + 5); env[k++] = pathVar; hadPath = true; }
        else env[k++] = environ[i];
    }
    if (!hadPath) { snprintf(pathVar, sizeof pathVar, "PATH=%s:/usr/bin:/bin", nodeDir); env[k++] = pathVar; }
    env[k] = NULL;

    char script[4096]; snprintf(script, sizeof script, "%s/src/ipc.js", appDir);
    char *argv[] = { node, script, NULL };
    if (chdir(appDir) != 0) { /* keep going */ }
    int rc = posix_spawn(&enginePid, node, &fa, NULL, argv, env);
    posix_spawn_file_actions_destroy(&fa);
    free(env);
    close(toEngine[0]); close(fromEngine[1]); if (logFd >= 0) close(logFd);
    if (rc != 0) { alert("Push Surface", "Couldn't start the Push Surface engine.", "Show log", logPath); return; }
    signal(SIGPIPE, SIG_IGN);
    engineIn = toEngine[1]; engineOut = fromEngine[0];
    pthread_t t; pthread_create(&t, NULL, reader, NULL); pthread_detach(t);
}

// ---- window -------------------------------------------------------------------------------
static void set_content_height(double h) {
    if (h < 120 || h > 900) return;
    Rect target = MSG(Rect, Rect)(window, S("frameRectForContentRect:"), (Rect){ 0, 0, WIDTH, h });
    Rect f = MSG(Rect)(window, S("frame"));
    f.y += f.h - target.h; // keep the top edge still
    f.w = target.w; f.h = target.h;
    MSG(void, Rect, bool, bool)(window, S("setFrame:display:animate:"), f, true, pageReady);
}

// WKScriptMessageHandler: messages from the page
static void did_receive(id self, SEL _cmd, id controller, id message) {
    (void)self; (void)_cmd; (void)controller;
    id body = MSG(id)(message, S("body"));
    if (!body || !MSG(bool, Class)(body, S("isKindOfClass:"), C("NSDictionary"))) return;
    const char *cmd = cstr(MSG(id, id)(body, S("objectForKey:"), str("cmd")));
    id arg = MSG(id, id)(body, S("objectForKey:"), str("arg"));
    if (!cmd) return;
    if (!strcmp(cmd, "mode")) {
        const char *m = arg && MSG(bool, Class)(arg, S("isKindOfClass:"), C("NSString")) ? cstr(arg) : "live";
        send_cmd(!strcmp(m, "demo") ? "{\"cmd\":\"mode\",\"arg\":\"demo\"}" : "{\"cmd\":\"mode\",\"arg\":\"live\"}");
    } else if (!strcmp(cmd, "reload")) {
        send_cmd("{\"cmd\":\"reload\"}");
    } else if (!strcmp(cmd, "settings") && configPath[0]) {
        pid_t pid; char *argv[] = { "/usr/bin/open", "-e", configPath, NULL };
        posix_spawn(&pid, "/usr/bin/open", NULL, NULL, argv, environ);
    } else if (!strcmp(cmd, "resize") && arg && MSG(bool, Class)(arg, S("isKindOfClass:"), C("NSNumber"))) {
        set_content_height(MSG(double)(arg, S("doubleValue")));
    }
}

// WKNavigationDelegate: page loaded → flush queued messages
static void did_finish(id self, SEL _cmd, id webView, id navigation) {
    (void)self; (void)_cmd; (void)webView; (void)navigation;
    pageReady = true;
    for (int i = 0; i < pendingCount; i++) { run_js(pending[i]); free(pending[i]); }
    pendingCount = 0;
}

static id menu_item(const char *title, const char *action, const char *key) {
    id item = MSG(id)(C("NSMenuItem"), S("alloc"));
    return MSG(id, id, SEL, id)(item, S("initWithTitle:action:keyEquivalent:"), str(title), action ? S(action) : NULL, str(key));
}
static id submenu(id mainMenu, const char *title) {
    id holder = alloc_init("NSMenuItem");
    MSG(void, id)(mainMenu, S("addItem:"), holder);
    id m = MSG(id, id)(MSG(id)(C("NSMenu"), S("alloc")), S("initWithTitle:"), str(title));
    MSG(void, id)(holder, S("setSubmenu:"), m);
    return m;
}
static void build_menu(void) {
    id mainMenu = alloc_init("NSMenu");
    id a = submenu(mainMenu, "Push Surface");
    MSG(void, id)(a, S("addItem:"), menu_item("About Push Surface", "orderFrontStandardAboutPanel:", ""));
    MSG(void, id)(a, S("addItem:"), MSG(id)(C("NSMenuItem"), S("separatorItem")));
    MSG(void, id)(a, S("addItem:"), menu_item("Hide Push Surface", "hide:", "h"));
    MSG(void, id)(a, S("addItem:"), MSG(id)(C("NSMenuItem"), S("separatorItem")));
    MSG(void, id)(a, S("addItem:"), menu_item("Quit Push Surface", "terminate:", "q"));
    id e = submenu(mainMenu, "Edit");
    MSG(void, id)(e, S("addItem:"), menu_item("Copy", "copy:", "c"));
    MSG(void, id)(e, S("addItem:"), menu_item("Select All", "selectAll:", "a"));
    id w = submenu(mainMenu, "Window");
    MSG(void, id)(w, S("addItem:"), menu_item("Minimize", "performMiniaturize:", "m"));
    MSG(void, id)(w, S("addItem:"), menu_item("Close", "performClose:", "w"));
    MSG(void, id)(app, S("setMainMenu:"), mainMenu);
}

static const char *SHIM =
    "(function () {"
    "  const cbs = { status: [], log: [] };"
    "  const post = (cmd, arg) => window.webkit.messageHandlers.ntpush.postMessage({ cmd: cmd, arg: arg === undefined ? null : arg });"
    "  window.ntpush = {"
    "    onStatus: (f) => cbs.status.push(f), onLog: (f) => cbs.log.push(f),"
    "    setMode: (m) => post('mode', m), reload: () => post('reload'),"
    "    openSettings: () => post('settings'), resize: (h) => post('resize', h),"
    "  };"
    "  window.__ntpush = (type, data) => (cbs[type] || []).forEach((f) => f(data));"
    "})();";

// NSApplicationDelegate
static void did_finish_launching(id self, SEL _cmd, id note) {
    (void)_cmd; (void)note;
    build_menu();

    id config = alloc_init("WKWebViewConfiguration");
    id ucc = MSG(id)(config, S("userContentController"));
    id script = MSG(id, id, long, bool)(MSG(id)(C("WKUserScript"), S("alloc")), S("initWithSource:injectionTime:forMainFrameOnly:"), str(SHIM), 0, true);
    MSG(void, id)(ucc, S("addUserScript:"), script);
    MSG(void, id, id)(ucc, S("addScriptMessageHandler:name:"), self, str("ntpush"));

    Rect r = { 0, 0, WIDTH, 320 };
    web = MSG(id, Rect, id)(MSG(id)(C("WKWebView"), S("alloc")), S("initWithFrame:configuration:"), r, config);
    MSG(void, id)(web, S("setNavigationDelegate:"), self);
    if (MSG(bool, SEL)(web, S("respondsToSelector:"), S("setUnderPageBackgroundColor:")))
        MSG(void, id)(web, S("setUnderPageBackgroundColor:"), MSG(id)(C("NSColor"), S("windowBackgroundColor")));

    window = MSG(id, Rect, unsigned long, unsigned long, bool)(MSG(id)(C("NSWindow"), S("alloc")),
        S("initWithContentRect:styleMask:backing:defer:"), r, 1 | 2 | 4 /* titled, closable, miniaturizable */, 2, false);
    MSG(void, id)(window, S("setTitle:"), str("Push Surface"));
    MSG(void, bool)(window, S("setTitlebarAppearsTransparent:"), true);
    MSG(void, id)(window, S("setBackgroundColor:"), MSG(id)(C("NSColor"), S("windowBackgroundColor")));
    MSG(void, bool)(window, S("setReleasedWhenClosed:"), false);
    MSG(void, id)(window, S("setContentView:"), web);
    MSG(void)(window, S("center"));
    MSG(bool, id)(window, S("setFrameAutosaveName:"), str("Push Surface status"));

    char page[4200]; snprintf(page, sizeof page, "%s/window.html", resources);
    id pageURL = MSG(id, id)(C("NSURL"), S("fileURLWithPath:"), str(page));
    id resURL = MSG(id, id)(C("NSURL"), S("fileURLWithPath:"), str(resources));
    MSG(id, id, id)(web, S("loadFileURL:allowingReadAccessToURL:"), pageURL, resURL);

    MSG(void, id)(window, S("makeKeyAndOrderFront:"), NULL);
    MSG(void, bool)(app, S("activateIgnoringOtherApps:"), true);

    start_engine();
}

static bool last_window_closed(id self, SEL _cmd, id sender) { (void)self; (void)_cmd; (void)sender; return true; }

// hand the Push back to Live mode before quitting
static void will_terminate(id self, SEL _cmd, id note) {
    (void)self; (void)_cmd; (void)note;
    quitting = true;
    if (enginePid <= 0) return;
    send_cmd("{\"cmd\":\"quit\"}");
    for (int i = 0; i < 60; i++) { // up to 3 s
        int st; if (waitpid(enginePid, &st, WNOHANG) == enginePid) return;
        usleep(50000);
    }
    kill(enginePid, SIGTERM);
}

// ---- main ---------------------------------------------------------------------------------
static bool load(void) {
    void *objc = dlopen("/usr/lib/libobjc.A.dylib", RTLD_NOW);
    void *sys = dlopen("/usr/lib/libSystem.B.dylib", RTLD_NOW);
    if (!objc || !sys) return false;
    if (!dlopen("/System/Library/Frameworks/AppKit.framework/AppKit", RTLD_NOW)) return false;
    if (!dlopen("/System/Library/Frameworks/WebKit.framework/WebKit", RTLD_NOW)) return false;
    getClass = dlsym(objc, "objc_getClass");
    selName = dlsym(objc, "sel_registerName");
    allocClassPair = dlsym(objc, "objc_allocateClassPair");
    registerClassPair = dlsym(objc, "objc_registerClassPair");
    addMethod = dlsym(objc, "class_addMethod");
    getProtocol = dlsym(objc, "objc_getProtocol");
    addProtocol = dlsym(objc, "class_addProtocol");
    msgSend = dlsym(objc, "objc_msgSend");
    dispatchAsync = dlsym(sys, "dispatch_async_f");
    mainQueue = dlsym(sys, "_dispatch_main_q");
    return getClass && selName && allocClassPair && registerClassPair && addMethod && msgSend && dispatchAsync && mainQueue;
}

int main(void) {
    if (!load()) { fprintf(stderr, "Push Surface: could not load AppKit/WebKit\n"); return 1; }

    // paths: <bundle>/Contents/Resources, logs in ~/Library/Logs
    id bundle = MSG(id)(C("NSBundle"), S("mainBundle"));
    snprintf(resources, sizeof resources, "%s", cstr(MSG(id)(bundle, S("resourcePath"))));
    snprintf(appDir, sizeof appDir, "%s/app", resources);
    const char *home = getenv("HOME");
    snprintf(logPath, sizeof logPath, "%s/Library/Logs/Push Surface.log", home ? home : "/tmp");

    // delegate class: app delegate + script message handler + navigation delegate
    Class cls = allocClassPair(C("NSObject"), "PushSurfaceDelegate", 0);
    addMethod(cls, S("applicationDidFinishLaunching:"), (void *)did_finish_launching, "v@:@");
    addMethod(cls, S("applicationShouldTerminateAfterLastWindowClosed:"), (void *)last_window_closed, "B@:@");
    addMethod(cls, S("applicationWillTerminate:"), (void *)will_terminate, "v@:@");
    addMethod(cls, S("userContentController:didReceiveScriptMessage:"), (void *)did_receive, "v@:@@");
    addMethod(cls, S("webView:didFinishNavigation:"), (void *)did_finish, "v@:@@");
    const char *protocols[] = { "NSApplicationDelegate", "WKScriptMessageHandler", "WKNavigationDelegate", NULL };
    for (int i = 0; protocols[i]; i++) { void *p = getProtocol(protocols[i]); if (p) addProtocol(cls, p); }
    registerClassPair(cls);

    id pool = alloc_init("NSAutoreleasePool");
    app = MSG(id)(C("NSApplication"), S("sharedApplication"));
    MSG(bool, long)(app, S("setActivationPolicy:"), 0); // regular app: Dock icon and menu bar
    id delegate = alloc_init("PushSurfaceDelegate");
    MSG(void, id)(app, S("setDelegate:"), delegate);
    MSG(void)(app, S("run"));
    (void)pool;
    return 0;
}
