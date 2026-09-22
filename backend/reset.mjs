/** 개발용 초기화 — erp.db 를 지우고 data.json 시드로 다시 만듭니다. */
import { rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const backendDir = fileURLToPath(new URL(".", import.meta.url));
for (const suffix of ["", "-wal", "-shm"]) {
  const file = join(backendDir, `erp.db${suffix}`);
  if (existsSync(file)) { rmSync(file); console.log(`삭제: erp.db${suffix}`); }
}
await import("./db.mjs");
console.log("erp.db 를 data.json 시드로 다시 생성했습니다.");
