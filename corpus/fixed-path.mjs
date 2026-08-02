// The one PATH value any corpus subprocess may see (Sonar S4036): a writable directory on an
// inherited PATH would let whatever got there first shadow `git` — or anything the pinned engine
// launches — inside a harness that runs with model credentials in its environment. These two
// directories are root-owned on every platform the harness supports (macOS and the Ubuntu
// runners), and both carry `git`.
export const FIXED_PATH = "/usr/bin:/bin";
