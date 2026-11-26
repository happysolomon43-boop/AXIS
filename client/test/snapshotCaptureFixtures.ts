import type { CaptureRequest, CaptureResult } from "../src/api/types";
import { b,c,chapterA,chapterPath,verRow,reply } from "./d06.fixtures";
export const capturePath = chapterPath + "/snapshots";
export const requestId = "00000000-0000-4000-8000-000000000001";
export function captureReply(body: CaptureRequest, created = true, current = true, version = verRow(c,3,b), name = "Saved name") {
  const capture: CaptureResult = { request_id:body.request_id, created_version:created, draft_current:current, version,
    snapshot:{ chapter_id:chapterA.id,version_id:version.id,kind:"snapshot",name,created_at:"2026-11-26T00:00:00.000Z",l_seq:version.l_seq,pack_pins:{} },
    active_version_id:null,sync:{state:"draft_only",same:false} };
  return reply({capture},201);
}
