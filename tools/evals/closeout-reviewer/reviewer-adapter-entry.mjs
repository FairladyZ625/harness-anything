import process from "node:process";

// Preserve the session leader PID and standard streams established by the parent.
process.execve("/bin/sh", ["sh", "-c", process.argv[2]], process.env);
