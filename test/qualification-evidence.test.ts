import test from "node:test";
import assert from "node:assert/strict";
import { isOpenCodeLocalToolSuccess } from "../scripts/qualification-evidence.js";

test("OpenCode successful local tools have provider-executed:false, not true", () => {
  const local = {
    nativeType: "session.tool.success",
    id: "synthetic-call",
    executed: false,
    content: [{ type: "text", text: "synthetic fixture content" }],
  };
  assert.equal(isOpenCodeLocalToolSuccess(local), true);
  assert.equal(isOpenCodeLocalToolSuccess({ ...local, executed: true }), false);
  assert.equal(
    isOpenCodeLocalToolSuccess({ ...local, executed: undefined }),
    false,
  );
  assert.equal(isOpenCodeLocalToolSuccess({ ...local, executed: 0 }), false);
  assert.equal(
    isOpenCodeLocalToolSuccess({ ...local, nativeType: "session.tool.called" }),
    false,
  );
  assert.equal(
    isOpenCodeLocalToolSuccess({ ...local, nativeType: "session.tool.failed" }),
    false,
  );
  assert.equal(isOpenCodeLocalToolSuccess({ ...local, id: "" }), false);
  for (const value of [null, undefined, false, 0, "success", [], {}]) {
    assert.equal(isOpenCodeLocalToolSuccess(value), false);
  }
});
