#include <errno.h>
#include <inttypes.h>
#include <libproc.h>
#include <limits.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/proc_info.h>
#include <unistd.h>

// Passive libproc reads only. No signals, launch, activation, argv or env reads.
static int fail(const char *reason, int code) {
    printf("{\"ok\":false,\"reason\":\"%s\"}\n", reason);
    return code;
}
static bool number(const char *value, uint64_t *result) {
    if (!value || !*value) return false;
    for (const char *p = value; *p; p++) if (*p < '0' || *p > '9') return false;
    errno = 0;
    char *end = NULL;
    unsigned long long n = strtoull(value, &end, 10);
    if (errno || !end || *end) return false;
    *result = (uint64_t)n;
    return true;
}
static bool executable(pid_t pid, char *canonical) {
    char raw[PROC_PIDPATHINFO_MAXSIZE];
    int n = proc_pidpath(pid, raw, sizeof(raw));
    return n > 0 && realpath(raw, canonical) != NULL;
}
static bool metadata(pid_t pid, struct proc_bsdinfo *info) {
    memset(info, 0, sizeof(*info));
    return proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, info, sizeof(*info)) == sizeof(*info)
        && info->pbi_pid == (uint32_t)pid && info->pbi_start_tvsec > 0;
}
static bool same_start(const struct proc_bsdinfo *a, const struct proc_bsdinfo *b) {
    return a->pbi_start_tvsec == b->pbi_start_tvsec
        && a->pbi_start_tvusec == b->pbi_start_tvusec;
}
static void item(pid_t pid, const struct proc_bsdinfo *info) {
    printf("{\"pid\":%d,\"uid\":%u,\"startSec\":%" PRIu64 ",\"startUsec\":%" PRIu64 "}",
           pid, info->pbi_uid, (uint64_t)info->pbi_start_tvsec, (uint64_t)info->pbi_start_tvusec);
}
int main(int argc, char **argv) {
    bool list = argc == 3 && strcmp(argv[1], "list") == 0;
    bool verify = argc == 6 && strcmp(argv[1], "verify") == 0;
    if (!list && !verify) return fail("usage: kernel-owner list EXACT_EXE | verify EXACT_EXE PID START_SEC START_USEC", 2);
    if (argv[2][0] != '/') return fail("expected_executable_must_be_absolute", 2);
    char expected[PATH_MAX];
    if (!realpath(argv[2], expected)) return fail("expected_executable_realpath_failed", 2);
    if (verify) {
        uint64_t pid_value, sec, usec;
        if (!number(argv[3], &pid_value) || pid_value == 0 || pid_value > INT_MAX
            || !number(argv[4], &sec) || sec == 0 || !number(argv[5], &usec) || usec >= 1000000)
            return fail("invalid_pid_or_start_identity", 2);
        pid_t pid = (pid_t)pid_value;
        char actual[PATH_MAX], again[PATH_MAX];
        struct proc_bsdinfo before, after;
        if (!metadata(pid, &before)) return fail("process_metadata_unavailable", 3);
        if (before.pbi_uid != getuid()) return fail("process_user_mismatch", 3);
        if ((uint64_t)before.pbi_start_tvsec != sec || (uint64_t)before.pbi_start_tvusec != usec)
            return fail("process_start_identity_changed", 3);
        if (!executable(pid, actual) || strcmp(actual, expected) != 0)
            return fail("process_executable_missing_or_mismatch", 3);
        if (!metadata(pid, &after) || !same_start(&before, &after) || after.pbi_uid != getuid()
            || !executable(pid, again) || strcmp(again, expected) != 0)
            return fail("process_identity_changed_during_read", 3);
        printf("{\"ok\":true,\"mode\":\"verify\",\"identity\":");
        item(pid, &after);
        printf("}\n");
        return 0;
    }
    int bytes = proc_listpids(PROC_ALL_PIDS, 0, NULL, 0);
    if (bytes <= 0 || bytes > 64 * 1024 * 1024) return fail("process_inventory_unavailable", 4);
    // Headroom permits processes created during the first sizing read.
    size_t capacity = (size_t)bytes + 4096 * sizeof(pid_t);
    pid_t *pids = calloc(1, capacity);
    if (!pids) return fail("process_inventory_allocation_failed", 4);
    int read = proc_listpids(PROC_ALL_PIDS, 0, pids, (int)capacity);
    if (read <= 0 || (size_t)read >= capacity) { free(pids); return fail("process_inventory_truncated_or_unavailable", 4); }
    size_t count = (size_t)read / sizeof(pid_t);
    struct match { pid_t pid; struct proc_bsdinfo info; } *matches = calloc(count ? count : 1, sizeof(*matches));
    if (!matches) { free(pids); return fail("match_allocation_failed", 4); }
    size_t matched = 0;
    for (size_t i = 0; i < count; i++) {
        if (pids[i] <= 0) continue;
        char path[PATH_MAX], again[PATH_MAX];
        // Never print unrelated process paths, argv, environment or identities.
        if (!executable(pids[i], path) || strcmp(path, expected) != 0) continue;
        struct proc_bsdinfo before, after;
        if (!metadata(pids[i], &before) || before.pbi_uid != getuid()
            || !executable(pids[i], again) || strcmp(again, expected) != 0
            || !metadata(pids[i], &after) || !same_start(&before, &after) || after.pbi_uid != getuid()) {
            free(matches); free(pids);
            return fail("matching_process_metadata_missing_or_identity_changed", 4);
        }
        matches[matched].pid = pids[i];
        matches[matched++].info = after;
    }
    free(pids);
    printf("{\"ok\":true,\"mode\":\"list\",\"matches\":[");
    for (size_t i = 0; i < matched; i++) { if (i) printf(","); item(matches[i].pid, &matches[i].info); }
    printf("]}\n");
    free(matches);
    return 0;
}
