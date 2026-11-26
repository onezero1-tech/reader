// scripts/redirect_vartmp.c
#define _GNU_SOURCE
#include <dlfcn.h>
#include <string.h>
#include <stdio.h>
#include <stdlib.h>
#include <fcntl.h>
#include <stdarg.h>

static const char *OLD_PREFIX = "/var/tmp/WebKit-Media-";
static const char *NEW_PREFIX = "/tmp/WebKit-Media-";

// 1. 拦截 mkstemp（GStreamer downloadbuffer / g_mkstemp 最常调用）
int mkstemp(char *template) {
    static int (*real_mkstemp)(char *) = NULL;
    if (!real_mkstemp) real_mkstemp = dlsym(RTLD_NEXT, "mkstemp");

    if (template && strncmp(template, OLD_PREFIX, strlen(OLD_PREFIX)) == 0) {
        char buf[512];
        snprintf(buf, sizeof(buf), "%s%s", NEW_PREFIX, template + strlen(OLD_PREFIX));
        // "/tmp/" 比 "/var/tmp/" 短 4 字节，原地覆盖绝对安全
        strcpy(template, buf);
    }
    return real_mkstemp(template);
}

int mkstemp64(char *template) {
    static int (*real_mkstemp64)(char *) = NULL;
    if (!real_mkstemp64) real_mkstemp64 = dlsym(RTLD_NEXT, "mkstemp64");

    if (template && strncmp(template, OLD_PREFIX, strlen(OLD_PREFIX)) == 0) {
        char buf[512];
        snprintf(buf, sizeof(buf), "%s%s", NEW_PREFIX, template + strlen(OLD_PREFIX));
        strcpy(template, buf);
    }
    return real_mkstemp64(template);
}

// 2. 兜底拦截 open / open64 / openat（防止直接调用 open 创建缓冲文件）
int open(const char *pathname, int flags, ...) {
    static int (*real_open)(const char *, int, ...) = NULL;
    if (!real_open) real_open = dlsym(RTLD_NEXT, "open");

    char buf[512];
    const char *target = pathname;
    if (pathname && strncmp(pathname, OLD_PREFIX, strlen(OLD_PREFIX)) == 0) {
        snprintf(buf, sizeof(buf), "%s%s", NEW_PREFIX, pathname + strlen(OLD_PREFIX));
        target = buf;
    }

    if (flags & O_CREAT) {
        va_list args;
        va_start(args, flags);
        mode_t mode = va_arg(args, mode_t);
        va_end(args);
        return real_open(target, flags, mode);
    }
    return real_open(target, flags);
}

int open64(const char *pathname, int flags, ...) {
    static int (*real_open64)(const char *, int, ...) = NULL;
    if (!real_open64) real_open64 = dlsym(RTLD_NEXT, "open64");

    char buf[512];
    const char *target = pathname;
    if (pathname && strncmp(pathname, OLD_PREFIX, strlen(OLD_PREFIX)) == 0) {
        snprintf(buf, sizeof(buf), "%s%s", NEW_PREFIX, pathname + strlen(OLD_PREFIX));
        target = buf;
    }

    if (flags & O_CREAT) {
        va_list args;
        va_start(args, flags);
        mode_t mode = va_arg(args, mode_t);
        va_end(args);
        return real_open64(target, flags, mode);
    }
    return real_open64(target, flags);
}

int openat(int dirfd, const char *pathname, int flags, ...) {
    static int (*real_openat)(int, const char *, int, ...) = NULL;
    if (!real_openat) real_openat = dlsym(RTLD_NEXT, "openat");

    char buf[512];
    const char *target = pathname;
    if (pathname && strncmp(pathname, OLD_PREFIX, strlen(OLD_PREFIX)) == 0) {
        snprintf(buf, sizeof(buf), "%s%s", NEW_PREFIX, pathname + strlen(OLD_PREFIX));
        target = buf;
    }

    if (flags & O_CREAT) {
        va_list args;
        va_start(args, flags);
        mode_t mode = va_arg(args, mode_t);
        va_end(args);
        return real_openat(dirfd, target, flags, mode);
    }
    return real_openat(dirfd, target, flags);
}
