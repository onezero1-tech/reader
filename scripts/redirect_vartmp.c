#define _GNU_SOURCE
#include <dlfcn.h>
#include <fcntl.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define OLD_PREFIX "/var/tmp/"
#define OLD_LEN 9

static const char *get_new_dir(void) {
    const char *dir = getenv("XDG_RUNTIME_DIR");
    if (dir && dir[0] == '/') return dir;
    dir = getenv("TMPDIR");
    if (dir && dir[0] == '/') return dir;
    return "/tmp";
}

static char *rewrite_path(const char *path) {
    if (!path || strncmp(path, OLD_PREFIX, OLD_LEN) != 0) {
        return NULL;
    }
    const char *new_dir = get_new_dir();
    size_t len = strlen(new_dir) + 1 + strlen(path + OLD_LEN) + 1;
    char *buf = malloc(len);
    if (buf) {
        snprintf(buf, len, "%s/%s", new_dir, path + OLD_LEN);
    }
    return buf;
}

static void sync_template(char *orig, const char *rewritten) {
    // 保留随机生成的后 6 位字符，避免调用方依赖模板内容
    size_t orig_len = strlen(orig);
    size_t new_len = strlen(rewritten);
    if (orig_len >= 6 && new_len >= 6) {
        memcpy(orig + orig_len - 6, rewritten + new_len - 6, 6);
    }
}

int mkstemp(char *template) {
    static int (*real_fn)(char *) = NULL;
    if (!real_fn) real_fn = dlsym(RTLD_NEXT, "mkstemp");
    char *new_path = rewrite_path(template);
    if (new_path) {
        int fd = real_fn(new_path);
        sync_template(template, new_path);
        free(new_path);
        return fd;
    }
    return real_fn(template);
}

int mkstemp64(char *template) {
    static int (*real_fn)(char *) = NULL;
    if (!real_fn) real_fn = dlsym(RTLD_NEXT, "mkstemp64");
    char *new_path = rewrite_path(template);
    if (new_path) {
        int fd = real_fn(new_path);
        sync_template(template, new_path);
        free(new_path);
        return fd;
    }
    return real_fn(template);
}

int mkostemp(char *template, int flags) {
    static int (*real_fn)(char *, int) = NULL;
    if (!real_fn) real_fn = dlsym(RTLD_NEXT, "mkostemp");
    char *new_path = rewrite_path(template);
    if (new_path) {
        int fd = real_fn(new_path, flags);
        sync_template(template, new_path);
        free(new_path);
        return fd;
    }
    return real_fn(template, flags);
}

int mkostemp64(char *template, int flags) {
    static int (*real_fn)(char *, int) = NULL;
    if (!real_fn) real_fn = dlsym(RTLD_NEXT, "mkostemp64");
    char *new_path = rewrite_path(template);
    if (new_path) {
        int fd = real_fn(new_path, flags);
        sync_template(template, new_path);
        free(new_path);
        return fd;
    }
    return real_fn(template, flags);
}

int open(const char *pathname, int flags, ...) {
    static int (*real_fn)(const char *, int, ...) = NULL;
    if (!real_fn) real_fn = dlsym(RTLD_NEXT, "open");
    mode_t mode = 0;
    if (flags & (O_CREAT | O_TMPFILE)) {
        va_list ap;
        va_start(ap, flags);
        mode = va_arg(ap, mode_t);
        va_end(ap);
    }
    char *new_path = rewrite_path(pathname);
    const char *target = new_path ? new_path : pathname;
    int fd = (flags & (O_CREAT | O_TMPFILE)) ? real_fn(target, flags, mode) : real_fn(target, flags);
    free(new_path);
    return fd;
}

int open64(const char *pathname, int flags, ...) {
    static int (*real_fn)(const char *, int, ...) = NULL;
    if (!real_fn) real_fn = dlsym(RTLD_NEXT, "open64");
    mode_t mode = 0;
    if (flags & (O_CREAT | O_TMPFILE)) {
        va_list ap;
        va_start(ap, flags);
        mode = va_arg(ap, mode_t);
        va_end(ap);
    }
    char *new_path = rewrite_path(pathname);
    const char *target = new_path ? new_path : pathname;
    int fd = (flags & (O_CREAT | O_TMPFILE)) ? real_fn(target, flags, mode) : real_fn(target, flags);
    free(new_path);
    return fd;
}

int openat(int dirfd, const char *pathname, int flags, ...) {
    static int (*real_fn)(int, const char *, int, ...) = NULL;
    if (!real_fn) real_fn = dlsym(RTLD_NEXT, "openat");
    mode_t mode = 0;
    if (flags & (O_CREAT | O_TMPFILE)) {
        va_list ap;
        va_start(ap, flags);
        mode = va_arg(ap, mode_t);
        va_end(ap);
    }
    char *new_path = rewrite_path(pathname);
    const char *target = new_path ? new_path : pathname;
    int fd = (flags & (O_CREAT | O_TMPFILE)) ? real_fn(dirfd, target, flags, mode) : real_fn(dirfd, target, flags);
    free(new_path);
    return fd;
}

int unlink(const char *pathname) {
    static int (*real_fn)(const char *) = NULL;
    if (!real_fn) real_fn = dlsym(RTLD_NEXT, "unlink");
    char *new_path = rewrite_path(pathname);
    int ret = real_fn(new_path ? new_path : pathname);
    free(new_path);
    return ret;
}

int unlinkat(int dirfd, const char *pathname, int flags) {
    static int (*real_fn)(int, const char *, int) = NULL;
    if (!real_fn) real_fn = dlsym(RTLD_NEXT, "unlinkat");
    char *new_path = rewrite_path(pathname);
    int ret = real_fn(dirfd, new_path ? new_path : pathname, flags);
    free(new_path);
    return ret;
}

int remove(const char *pathname) {
    static int (*real_fn)(const char *) = NULL;
    if (!real_fn) real_fn = dlsym(RTLD_NEXT, "remove");
    char *new_path = rewrite_path(pathname);
    int ret = real_fn(new_path ? new_path : pathname);
    free(new_path);
    return ret;
}

