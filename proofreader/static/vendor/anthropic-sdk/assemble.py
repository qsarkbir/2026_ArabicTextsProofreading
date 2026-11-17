"""Assemble the browser-loadable copy of @anthropic-ai/sdk (see README.md in this folder)."""
import os, re, sys, shutil, hashlib, json
# usage: python3 -I assemble.py <@anthropic-ai/sdk package dir> <@opentelemetry/api package dir> <dest dir>
SDK, OTELPKG, DEST = sys.argv[1:4]
OTEL = os.path.join(OTELPKG, "dist")
shutil.rmtree(DEST, ignore_errors=True)
rx = re.compile(r'''((?:^|[\s;}])(?:import|export)\s[^'"`;]*?from\s*|(?:^|[\s;])import\s*|import\(\s*)(['"])([^'"]+)\2''', re.M)
patched = []  # (file, old, new)
queue = [("sdk", "index.mjs"), ("otel", "index.mjs")]
seen = set()
roots = {"sdk": (SDK, ""), "otel": (OTEL, "_deps/opentelemetry-api/")}
def dest_of(kind, rel): return roots[kind][1] + rel
def rel_import(frm, to):
    r = os.path.relpath(to, os.path.dirname(frm) or ".")
    return r if r.startswith(".") else "./" + r
while queue:
    kind, rel = queue.pop()
    if (kind, rel) in seen: continue
    seen.add((kind, rel))
    root = roots[kind][0]
    src = open(os.path.join(root, rel), encoding="utf-8").read()
    me = dest_of(kind, rel)
    def sub(m):
        spec = m.group(3); new = spec
        if spec == "@opentelemetry/api": new = rel_import(me, "_deps/opentelemetry-api/index.mjs")
        elif spec == "standardwebhooks": new = rel_import(me, "_stubs/standardwebhooks.mjs")
        elif spec == "@anthropic-ai/sdk/tools/agent-toolset/node": new = rel_import(me, "tools/agent-toolset/node.browser.mjs")
        elif spec.startswith(".") and re.search(r"(^|/)node\.mjs$", spec): new = spec[:-len("node.mjs")] + "node.browser.mjs"
        elif spec.startswith("node:") and rel != "internal/uploads.mjs": raise SystemExit(f"node builtin import in {me}: {spec}")
        if new != spec:
            patched.append((me, spec, new))
        return m.group(0) if new == spec else m.group(0).replace(spec, new)
    out = re.sub(r"\n?//# sourceMappingURL=\S+\s*$", "\n", rx.sub(sub, src))
    # enqueue relative targets from the ORIGINAL specifiers (after node.mjs substitution)
    for m in rx.finditer(src):
        spec = m.group(3)
        if not spec.startswith("."): continue
        if re.search(r"(^|/)node\.mjs$", spec): spec = spec[:-len("node.mjs")] + "node.browser.mjs"
        t = os.path.normpath(os.path.join(os.path.dirname(rel), spec))
        if not os.path.exists(os.path.join(root, t)):
            for c in (t + ".mjs", t + "/index.mjs"):
                if os.path.exists(os.path.join(root, c)): t = c; break
        queue.append((kind, t))
    p = os.path.join(DEST, me); os.makedirs(os.path.dirname(p), exist_ok=True)
    open(p, "w", encoding="utf-8", newline="").write(out)
os.makedirs(f"{DEST}/_stubs", exist_ok=True)
open(f"{DEST}/_stubs/standardwebhooks.mjs", "w").write("// Local stub: the Webhooks resource (server-side signature checks) is not used by the proofreader.\nexport class Webhook {\n  constructor() { throw new Error('standardwebhooks is not included in this build'); }\n}\n")
shutil.copy(f"{SDK}/LICENSE", f"{DEST}/LICENSE")
shutil.copy(f"{SDK}/LICENSE-MIT", f"{DEST}/LICENSE-MIT")
shutil.copy(os.path.join(OTELPKG, "LICENSE"), f"{DEST}/_deps/opentelemetry-api/LICENSE")
for f, a, b in sorted(patched): print("PATCH", f, a, "->", b)
