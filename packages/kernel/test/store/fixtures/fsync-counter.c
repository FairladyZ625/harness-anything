#include <fcntl.h>
#include <stdlib.h>
#include <sys/syscall.h>
#include <unistd.h>

__attribute__((constructor, used)) static void load_counter(void) {
  const char *trace = getenv("HA_FSYNC_TRACE");
  if (trace != NULL) {
    int out = open(trace, O_WRONLY | O_CREAT | O_APPEND, 0600);
    if (out >= 0) { (void)write(out, "loaded\n", 7); (void)close(out); }
  }
}

static int counted_fsync(int fd) {
  const char *trace = getenv("HA_FSYNC_TRACE");
  if (trace != NULL) {
    int out = open(trace, O_WRONLY | O_CREAT | O_APPEND, 0600);
    if (out >= 0) {
      (void)write(out, "fsync\n", 6);
      (void)close(out);
    }
  }
  return (int)syscall(SYS_fsync, fd);
}

static int counted_fcntl(int fd, int command, void *argument) {
  if (command == F_FULLFSYNC) {
    const char *trace = getenv("HA_FSYNC_TRACE");
    if (trace != NULL) {
      int out = open(trace, O_WRONLY | O_CREAT | O_APPEND, 0600);
      if (out >= 0) {
        (void)write(out, "fullfsync\n", 10);
        (void)close(out);
      }
    }
    return (int)syscall(SYS_fcntl, fd, command, argument);
  }
  return (int)syscall(SYS_fcntl, fd, command, argument);
}

#define DYLD_INTERPOSE(_replacement, _replacee) \
  __attribute__((used)) static struct { const void *replacement; const void *replacee; } _interpose_##_replacee \
  __attribute__((section("__DATA,__interpose"))) = { (const void *)(unsigned long)&_replacement, (const void *)(unsigned long)&_replacee };

DYLD_INTERPOSE(counted_fsync, fsync)
DYLD_INTERPOSE(counted_fcntl, fcntl)
