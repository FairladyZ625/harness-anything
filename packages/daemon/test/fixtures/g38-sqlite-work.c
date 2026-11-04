/* Fixture-only SQLite work observation. The progress callback never executes SQL.
 * https://sqlite.org/c3ref/progress_handler.html
 * https://sqlite.org/c3ref/c_dbstatus_options.html
 */
#include "sqlite3ext.h"
SQLITE_EXTENSION_INIT1

typedef struct {
  sqlite3 *db;
  sqlite3_int64 steps, scan_pages, scan_start;
  int paused, scan_depth;
} Work;

static int progress(void *pointer) {
  Work *work = pointer;
  if (!work->paused) work->steps++;
  return 0;
}

static int pages(Work *work, sqlite3_int64 *value) {
  int hits = 0, misses = 0, ignored = 0;
  int result = sqlite3_db_status(work->db, SQLITE_DBSTATUS_CACHE_HIT, &hits, &ignored, 0);
  if (result == SQLITE_OK)
    result = sqlite3_db_status(work->db, SQLITE_DBSTATUS_CACHE_MISS, &misses, &ignored, 0);
  *value = (sqlite3_int64)hits + misses;
  return result;
}

/* 0=VM work, 1=scan pages (second arg resets); 2/3=start/end a Count or exec;
 * 4=pause observer-only EXPLAIN work. Indexed-search page height is not a scan.
 */
static void read_work(sqlite3_context *context, int argc, sqlite3_value **argv) {
  Work *work = sqlite3_user_data(context);
  int mode = sqlite3_value_int(argv[0]), reset = sqlite3_value_int(argv[1]);
  if (mode == 0) {
    sqlite3_result_int64(context, work->steps);
    if (reset) work->steps = 0;
  } else if (mode == 1) {
    sqlite3_result_int64(context, work->scan_pages);
    if (reset) work->scan_pages = 0;
  } else if (mode == 4) {
    work->paused = reset;
    sqlite3_result_int(context, 0);
  } else {
    sqlite3_int64 current = 0;
    int result = pages(work, &current);
    if (result != SQLITE_OK) {
      sqlite3_result_error_code(context, result);
      return;
    }
    if (mode == 2 && work->scan_depth++ == 0) work->scan_start = current;
    if (mode == 3 && --work->scan_depth == 0) work->scan_pages += current - work->scan_start;
    sqlite3_result_int(context, 0);
  }
}

static void destroy(void *pointer) {
  Work *work = pointer;
  sqlite3_progress_handler(work->db, 0, 0, 0);
  sqlite3_free(work);
}

static int register_work(sqlite3 *db, char **error, const sqlite3_api_routines *api) {
  SQLITE_EXTENSION_INIT2(api);
  Work *work = sqlite3_malloc(sizeof(Work));
  if (!work) return SQLITE_NOMEM;
  *work = (Work){db, 0, 0, 0, 0, 0};
  int result = sqlite3_create_function_v2(db, "g38_read_work", 2,
      SQLITE_UTF8 | SQLITE_DIRECTONLY, work, read_work, 0, 0, destroy);
  if (result == SQLITE_OK) sqlite3_progress_handler(db, 1, progress, work);
  return result;
}

#ifdef _WIN32
__declspec(dllexport)
#endif
int sqlite3_g38work_init(sqlite3 *db, char **error, const sqlite3_api_routines *api) {
  SQLITE_EXTENSION_INIT2(api);
  int result = register_work(db, error, api);
  if (result != SQLITE_OK) return result;
  result = sqlite3_auto_extension((void (*)(void))register_work);
  return result == SQLITE_OK ? SQLITE_OK_LOAD_PERMANENTLY : result;
}
