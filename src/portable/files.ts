import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { portableCanonical as canonical } from "./canonical.js";
import {
  parseDocument,
  validateDocument,
  transitions,
  DOCUMENT_LIMIT,
} from "./validation.js";
import type { WorkflowDocument, ValidatedWorkflow } from "./model.js";
export const bytesHash = (text: string): string =>
  createHash("sha256").update(text).digest("hex");
/** Only the explicit CLI loader resolves local imports. Shared documents are closed. */
export function loadDocument(path: string): ValidatedWorkflow {
  const root = realpathSync(dirname(resolve(path))),
    active = new Set<string>(),
    seen = new Set<string>();
  let total = 0;
  const load = (file: string): WorkflowDocument => {
    const actual = realpathSync(file),
      rel = relative(root, actual);
    if (rel.startsWith("..") || isAbsolute(rel))
      throw new Error("Workflow import escapes source directory");
    if (active.has(actual)) throw new Error("Workflow import cycle");
    if (seen.has(actual)) throw new Error("Duplicate workflow import");
    if (seen.size >= 64) throw new Error("Workflow closure exceeds 64 files");
    seen.add(actual);
    active.add(actual);
    const source = readFileSync(actual, "utf8");
    total += Buffer.byteLength(source);
    if (total > 4 * DOCUMENT_LIMIT)
      throw new Error("Workflow closure exceeds 4 MiB");
    const raw = parseDocument(source) as WorkflowDocument & {
      imports?: unknown;
    };
    const imports = raw.imports;
    delete raw.imports;
    if (imports !== undefined) {
      if (
        !Array.isArray(imports) ||
        imports.some(
          (x) =>
            typeof x !== "string" ||
            isAbsolute(x) ||
            x.split(/[\\/]/).includes(".."),
        )
      )
        throw new Error("Invalid local workflow imports");
      for (const name of imports as string[]) {
        const child = load(resolve(dirname(actual), name));
        if (child.format !== raw.format)
          throw new Error("Imported workflow format differs");
        for (const [k, v] of Object.entries(child.workflows)) {
          if (Object.hasOwn(raw.workflows, k))
            throw new Error(`Duplicate workflow definition ${k}`);
          raw.workflows[k] = v;
        }
        for (const [k, v] of Object.entries(child.profiles ?? {})) {
          raw.profiles ??= {};
          if (Object.hasOwn(raw.profiles, k))
            throw new Error(`Duplicate profile ${k}`);
          raw.profiles[k] = v;
        }
      }
    }
    active.delete(actual);
    return raw;
  };
  return validateDocument(load(resolve(path)));
}
const escape = (text: string): string =>
  text.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[c]!,
  );
export function supportReport(
  document: WorkflowDocument,
): Record<string, unknown> {
  return {
    format: document.format,
    validation: "supported",
    render: "supported without provider accounts",
    execution:
      "requires recipient bindings and explicit trusted commands/components",
    resume:
      "same semantic closure and bindings; uncertain work stops; native checkpoints are not imported",
    nativeExport: "unsupported; generate an ASF TypeScript driver instead",
    frameworks: ["codex", "opencode", "adk"],
  };
}
/** Render declared topology only. No provider imports or executable registrations. */
export function renderDocument(raw: WorkflowDocument): string {
  const { document, identity } = validateDocument(raw);
  let offset = 70;
  const sections: string[] = [];
  for (const [name, w] of Object.entries(document.workflows)) {
    const coords = new Map(
      w.nodes.map((n, i) => [
        n.id,
        { x: 200 + (i % 3) * 270, y: offset + 100 + Math.floor(i / 3) * 115 },
      ]),
    );
    const height = Math.ceil(w.nodes.length / 3) * 115 + 120;
    sections.push(
      `<text x="20" y="${offset}" class="heading">${escape(name)} v${escape(w.version)}</text><text x="20" y="${offset + 24}">input → output; default profile: ${escape(w.defaultProfile ?? "none")}</text>`,
    );
    for (const n of w.nodes) {
      const p = coords.get(n.id)!;
      for (const next of transitions(n)) {
        const q = coords.get(next)!;
        sections.push(
          `<path d="M ${p.x} ${p.y + 25} L ${q.x} ${q.y - 25}" marker-end="url(#arrow)"/>`,
        );
      }
    }
    for (const n of w.nodes) {
      const p = coords.get(n.id)!,
        child = "workflow" in n ? ` → ${n.workflow}` : "";
      sections.push(
        `<g><rect x="${p.x - 115}" y="${p.y - 25}" width="230" height="65" rx="8"/><text x="${p.x - 105}" y="${p.y}">${escape(n.id)} · ${escape(n.kind)}</text><text x="${p.x - 105}" y="${p.y + 20}">${escape(child || ("profile" in n ? (n.profile ?? w.defaultProfile ?? "") : n.kind === "repeat" ? String(n.maxIterations) : ""))}</text></g>`,
      );
    }
    offset += height;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1020" height="${offset + 50}" role="img" aria-label="Declared workflow graph"><style>text{font:13px sans-serif;fill:#20304a}.heading{font-size:19px}rect{fill:#eef3ff;stroke:#7e94b5}path{fill:none;stroke:#7e94b5}</style><defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0 0L8 4L0 8Z"/></marker></defs><text x="20" y="25">ASF-TS ${identity}</text>${sections.join("")}<text x="20" y="${offset + 20}">Declared transitions only. Execution and resume require recipient preflight.</text></svg>`;
}
interface Bundle {
  format: "asf-ts-bundle/v1";
  members: Record<string, { sha256: string; data: string }>;
  workflowIdentity: string;
  support: Record<string, unknown>;
}
export function bundleDocument(raw: WorkflowDocument): string {
  const v = validateDocument(raw),
    source = canonical(v.document);
  const members = Object.fromEntries(
    Object.entries({
      "workflow.json": source,
      "workflow.svg": renderDocument(v.document),
    }).map(([k, data]) => [k, { data, sha256: bytesHash(data) }]),
  );
  return canonical({
    format: "asf-ts-bundle/v1",
    members,
    workflowIdentity: v.identity,
    support: supportReport(v.document),
  });
}
export function verifyBundle(source: string): ValidatedWorkflow {
  if (Buffer.byteLength(source) > 8 * DOCUMENT_LIMIT)
    throw new Error("Bundle too large");
  const bundle = parseDocument(source, 8 * DOCUMENT_LIMIT) as unknown as Bundle;
  if (
    !bundle ||
    bundle.format !== "asf-ts-bundle/v1" ||
    Object.keys(bundle).sort().join(",") !==
      "format,members,support,workflowIdentity" ||
    !bundle.members ||
    Object.keys(bundle.members).sort().join(",") !==
      "workflow.json,workflow.svg"
  )
    throw new Error("Invalid bundle members");
  for (const member of Object.values(bundle.members)) {
    if (
      !member ||
      Object.keys(member).sort().join(",") !== "data,sha256" ||
      typeof member.data !== "string" ||
      typeof member.sha256 !== "string" ||
      Buffer.byteLength(member.data) > 4 * DOCUMENT_LIMIT ||
      bytesHash(member.data) !== member.sha256
    )
      throw new Error("Bundle integrity mismatch");
  }
  const v = validateDocument(
    parseDocument(bundle.members["workflow.json"]!.data),
  );
  if (
    v.identity !== bundle.workflowIdentity ||
    canonical(supportReport(v.document)) !== canonical(bundle.support) ||
    renderDocument(v.document) !== bundle.members["workflow.svg"]!.data
  )
    throw new Error("Bundle manifest mismatch");
  return v;
}
export interface CompileOptions {
  runtimeImport?: string;
  registration?: string;
  targets?: string;
}
export function compileDocument(
  raw: WorkflowDocument,
  options: CompileOptions = {},
): string {
  const v = validateDocument(raw),
    registration = options.registration
      ? {
          path: realpathSync(options.registration),
          sha256: bytesHash(readFileSync(options.registration, "utf8")),
        }
      : null;
  if (
    Object.values(v.document.workflows).some((w) =>
      w.nodes.some((n) => n.kind === "custom"),
    ) &&
    !registration
  )
    throw new Error(
      "Custom components require explicit --registration at compilation",
    );
  const targets = options.targets
    ? {
        path: realpathSync(options.targets),
        sha256: bytesHash(readFileSync(options.targets, "utf8")),
      }
    : null;
  const runtime =
    options.runtimeImport ??
    fileURLToPath(new URL("./index.js", import.meta.url));
  return `// Generated ASF-TS driver. Source identity: ${v.identity}\n// Registration/target modules are separately trusted code.\nimport { executeDocument, bindingsFromAgents, loadRegistration, loadTargetBindings, type Runtime, type Json, type AgentConfig, type WorkflowDocument } from ${JSON.stringify(runtime)};\nconst document: WorkflowDocument = ${JSON.stringify(v.document, null, 2)};\nconst registration = ${JSON.stringify(registration)} as {path:string;sha256:string}|null;\nconst targets = ${JSON.stringify(targets)} as {path:string;sha256:string}|null;\nexport async function workflow(runtime: Runtime, input: Json, agents: Record<string, AgentConfig>): Promise<Json> {\n  const components = registration ? await loadRegistration(registration.path, registration.sha256) : {};\n  const bindings = targets ? await loadTargetBindings(targets.path, targets.sha256) : bindingsFromAgents(agents);\n  try { return (await executeDocument(runtime, document, input, {bindings,components})).value; }\n  finally { if (targets) await Promise.allSettled([...new Set(Object.values(bindings).map(b=>b.agent.harness))].map(h=>h.close?.())); }\n}\n`;
}
/** Called only after explicit file-run/compiler authorization, never parse/render/UI. */
export async function loadRegistration(
  path: string,
  expectedSha256?: string,
): Promise<Record<string, import("./execute.js").Component>> {
  const actual = realpathSync(path);
  if (
    expectedSha256 &&
    bytesHash(readFileSync(actual, "utf8")) !== expectedSha256
  )
    throw new Error("Trusted registration source changed");
  const module = (await import(pathToFileURL(actual).href)) as {
    components?: Record<string, import("./execute.js").Component>;
  };
  if (!module.components || typeof module.components !== "object")
    throw new Error("Registration module must export components");
  const source = bytesHash(readFileSync(actual, "utf8"));
  return Object.fromEntries(
    Object.entries(module.components).map(([name, c]) => [
      name,
      { ...c, identity: { declared: c.identity, source } },
    ]),
  );
}
/** Explicit trusted target module; never loaded by source validation or UI. */
export async function loadTargetBindings(
  path: string,
  expectedSha256?: string,
): Promise<Record<string, import("../profiles.js").ProfileBinding>> {
  const actual = realpathSync(path),
    source = bytesHash(readFileSync(actual, "utf8"));
  if (expectedSha256 && source !== expectedSha256)
    throw new Error("Trusted target source changed");
  const module = (await import(pathToFileURL(actual).href)) as {
    bindings?: Record<string, import("../profiles.js").ProfileBinding>;
  };
  if (!module.bindings || typeof module.bindings !== "object")
    throw new Error("Target module must export bindings");
  return Object.fromEntries(
    Object.entries(module.bindings).map(([name, b]) => [
      name,
      {
        ...b,
        capabilities: {
          ...b.capabilities,
          revision: `${b.capabilities.revision}:source-${source}`,
        },
      },
    ]),
  );
}
export function writeArtifact(path: string, contents: string): void {
  writeFileSync(resolve(path), contents, { flag: "wx", mode: 0o600 });
}
