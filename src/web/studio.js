/* Local data authoring. File generation and execution belong to the CLI. */
/** @typedef {{id:string, kind:string, next?:string, then?:string, else?:string, profile?:string, workflow?:string, branches?:{id:string,workflow:string,input:unknown}[], [key:string]:unknown}} StudioBlock */
/** @typedef {{x:number,y:number}} StudioPosition */
/** @typedef {{version:string,inputSchema:unknown,outputSchema:unknown,start:string,nodes:StudioBlock[],defaultProfile?:string,layout?:Record<string,StudioPosition>,[key:string]:unknown}} StudioDefinition */
/** @typedef {{format:string,root:string,workflows:Record<string,StudioDefinition>,profiles?:unknown}} StudioDocument */
/** @typedef {HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement} StudioControl */
/** @typedef {{control:StudioControl,type:string,change:(value:unknown)=>void,label:string,optional:boolean}} StudioDraft */
/** @typedef {{values?:string[],optional?:boolean,min?:number,max?:number,label?:string}} StudioFieldOptions */
/** @param {string} id @returns {HTMLElement} */
const studioElement = (id) => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing editor element ${id}`);
  return element;
};
/** @param {string} id @returns {StudioControl} */
const studioControl = (id) => {
  const element = studioElement(id);
  if (
    !(
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLSelectElement
    )
  )
    throw new Error(`Missing editor control ${id}`);
  return element;
};
/** @param {string} id @returns {HTMLButtonElement} */
const studioButton = (id) => {
  const element = studioElement(id);
  if (!(element instanceof HTMLButtonElement))
    throw new Error(`Missing editor button ${id}`);
  return element;
};
/** @template {keyof HTMLElementTagNameMap} T @param {T} tag @param {unknown} [text] @returns {HTMLElementTagNameMap[T]} */
const studioText = (tag, text) => {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = String(text);
  return element;
};
/** @param {unknown} value @returns {string} */
const studioJSON = (value) => JSON.stringify(value, null, 2);
/** @template T @param {T} value @returns {T} */
const studioClone = (value) => JSON.parse(JSON.stringify(value));
/** @type {{document:StudioDocument,workflow:string,selected:string,revision:number,validated:number,sourceDirty:boolean,drafts:Map<string,StudioDraft>,scopes:WeakMap<object,number>,nextScope:number,yaml:string,catalogue:{kind:string,label:string,description:string}[]}} */
const studioState = {
  document: studioNewDocument(),
  workflow: "",
  selected: "",
  revision: 0,
  validated: -1,
  sourceDirty: false,
  drafts: new Map(),
  scopes: new WeakMap(),
  nextScope: 0,
  yaml: "",
  catalogue: [],
};
/** @param {string} text @param {string} [kind] */
function studioNotice(text, kind = "") {
  studioElement("studio-message").textContent = text;
  studioElement("studio-message").className = kind;
}
function studioDirty() {
  studioState.revision++;
  studioState.validated = -1;
  studioButton("studio-download").disabled = true;
  studioElement("studio-status").textContent =
    "Draft · validate before download";
}
function studioDefinition() {
  return studioState.document.workflows[studioState.workflow];
}
function studioNode() {
  return studioDefinition().nodes.find(
    (node) => node.id === studioState.selected,
  );
}
/** @returns {StudioDefinition} */
function studioNewDefinition() {
  return {
    version: "1",
    inputSchema: {},
    outputSchema: {},
    start: "complete",
    nodes: [
      {
        id: "complete",
        kind: "end",
        output: { $ref: "#/input" },
        passed: true,
      },
    ],
  };
}
/** @returns {StudioDocument} */
function studioNewDocument() {
  return {
    format: "asf-ts-workflow/v1",
    root: "main",
    workflows: { main: studioNewDefinition() },
    profiles: {},
  };
}
/** @param {object} value @returns {number} */
function studioScope(value) {
  if (!studioState.scopes.has(value))
    studioState.scopes.set(value, ++studioState.nextScope);
  return /** @type {number} */ (studioState.scopes.get(value));
}
/** @param {string} value @param {string} [label] */
function studioOption(value, label = value) {
  const option = studioText("option", label);
  option.value = value;
  return option;
}
/** @param {HTMLElement} element @param {string[]} values @param {string} [selected] */
function studioSelect(element, values, selected) {
  if (!(element instanceof HTMLSelectElement))
    throw new Error("Expected a select control");
  const options = [...values];
  if (selected !== undefined && !options.includes(selected))
    options.push(selected);
  element.replaceChildren(...options.map((value) => studioOption(value)));
  element.value = selected ?? "";
}
function studioSource() {
  if (!studioState.sourceDirty)
    studioControl("studio-source").value = studioJSON(studioState.document);
}
/** @param {StudioDocument} document */
function studioLoad(document) {
  studioState.document = studioClone(document);
  studioState.workflow = document.root;
  studioState.selected = studioDefinition().start;
  studioState.sourceDirty = false;
  studioState.drafts.clear();
  studioDirty();
  studioRender();
}
function studioWritable() {
  if (!studioState.sourceDirty) return true;
  studioNotice(
    "Apply the pending source before editing forms or blocks.",
    "error",
  );
  return false;
}
/** @param {string} key @param {StudioDraft} draft */
function studioApplyField(key, draft) {
  const { control, type, change, label, optional } = draft;
  try {
    control.setCustomValidity("");
    const value =
      optional && control.value === ""
        ? undefined
        : type === "json"
          ? JSON.parse(control.value)
          : type === "number"
            ? Number(control.value)
            : control.value;
    if (!control.checkValidity()) throw new Error(control.validationMessage);
    if (!studioWritable())
      throw new Error("Apply the pending source before changing a field");
    change(value);
    studioState.drafts.delete(key);
    studioSource();
    studioRenderGraph();
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    control.setCustomValidity(message);
    studioState.drafts.set(key, draft);
    studioDirty();
    studioNotice(`${label}: ${message}`, "error");
    return false;
  }
}
/** @param {HTMLElement} form @param {object} scope @param {string} name @param {unknown} value @param {string} type @param {(value:unknown)=>void} change @param {StudioFieldOptions} [options] */
function studioField(form, scope, name, value, type, change, options = {}) {
  const { values = [], optional = false, min, max, label = name } = options;
  const key = `${studioScope(scope)}:${name}`,
    pending = studioState.drafts.get(key);
  const group = studioText("label", label);
  let control;
  if (type === "select") {
    control = studioText("select");
    studioSelect(
      control,
      values,
      value === undefined ? undefined : String(value),
    );
  } else {
    control = studioText(
      type === "json" || type === "multiline" ? "textarea" : "input",
    );
    control.value =
      type === "json"
        ? studioJSON(value ?? (optional ? null : {}))
        : String(value ?? "");
    if (control instanceof HTMLTextAreaElement) {
      control.rows = type === "json" ? 5 : 4;
      control.spellcheck = false;
    }
    if (type === "number" && control instanceof HTMLInputElement) {
      control.type = "number";
      if (min !== undefined) control.min = String(min);
      if (max !== undefined) control.max = String(max);
    }
  }
  control.id = `studio-field-${studioScope(scope)}-${name}`;
  control.setAttribute("aria-label", label);
  control.required = !optional && type !== "select";
  if (pending) {
    control.value = pending.control.value;
    control.setCustomValidity(pending.control.validationMessage);
  }
  const draft = { control, type, change, label, optional };
  if (pending) studioState.drafts.set(key, draft);
  control.addEventListener("input", () => {
    control.setCustomValidity("");
    studioState.drafts.set(key, draft);
    studioDirty();
  });
  control.addEventListener("change", () => {
    studioDirty();
    studioApplyField(key, draft);
  });
  group.append(control);
  form.append(group);
  return control;
}
function studioRender() {
  studioSelect(
    studioElement("studio-definition"),
    Object.keys(studioState.document.workflows),
    studioState.workflow,
  );
  studioSelect(
    studioElement("studio-root"),
    Object.keys(studioState.document.workflows),
    studioState.document.root,
  );
  studioSource();
  studioRenderSettings();
  studioRenderProfiles();
  studioRenderGraph();
  studioRenderNode();
}
function studioRenderSettings() {
  const form = studioElement("studio-workflow-form"),
    definition = studioDefinition();
  form.replaceChildren();
  for (const [name, label, type] of [
    ["version", "Version", "text"],
    ["inputSchema", "Workflow input schema", "json"],
    ["outputSchema", "Workflow output schema", "json"],
  ])
    studioField(
      form,
      definition,
      name,
      definition[name],
      type,
      (value) => {
        definition[name] = value;
      },
      { label },
    );
  studioField(
    form,
    definition,
    "defaultProfile",
    definition.defaultProfile ?? "",
    "select",
    (value) => {
      if (value) definition.defaultProfile = String(value);
      else delete definition.defaultProfile;
    },
    {
      values: ["", ...Object.keys(studioState.document.profiles ?? {})],
      label: "Workflow default profile",
    },
  );
  studioField(
    form,
    definition,
    "start",
    definition.start,
    "select",
    (value) => {
      definition.start = String(value);
    },
    { values: definition.nodes.map((node) => node.id), label: "Start block" },
  );
}
function studioRenderProfiles() {
  const control = studioControl("studio-profiles"),
    scope = studioScope(studioState.document),
    key = `${scope}:profiles`,
    draft = studioState.drafts.get(key);
  control.value =
    draft?.control.value ?? studioJSON(studioState.document.profiles ?? {});
  /** @type {StudioDraft} */
  const next = {
    control,
    type: "json",
    label: "Named profile intents",
    optional: false,
    change: (value) => {
      studioState.document.profiles = value;
      studioRenderSettings();
    },
  };
  if (draft) studioState.drafts.set(key, next);
  control.oninput = () => {
    control.setCustomValidity("");
    studioState.drafts.set(key, next);
    studioDirty();
  };
  control.onchange = () => {
    studioDirty();
    studioApplyField(key, next);
  };
}
/** @param {StudioBlock} node @param {number} index @returns {StudioPosition} */
function studioPosition(node, index) {
  return studioDefinition().layout?.[node.id] ?? { x: 30 + index * 255, y: 35 };
}
/** @param {StudioBlock} node @returns {[string,string|undefined][]} */
function studioEdges(node) {
  if (node.kind === "end") return [];
  if (node.kind === "branch")
    return [
      ["true", node.then],
      ["false", node.else],
    ];
  return [["next", node.next]];
}
/** @template {keyof SVGElementTagNameMap} T @param {T} tag @param {Record<string,string|number|boolean>} attributes @param {unknown} [text] @returns {SVGElementTagNameMap[T]} */
function studioSVG(tag, attributes, text) {
  const element = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attributes))
    element.setAttribute(key, String(value));
  if (text !== undefined) element.textContent = String(text);
  return element;
}
function studioRenderGraph() {
  const graph = studioElement("studio-graph"),
    definition = studioDefinition();
  graph.replaceChildren();
  const definitions = studioSVG("defs", {}),
    marker = studioSVG("marker", {
      id: "studio-arrow",
      viewBox: "0 0 10 10",
      refX: 9,
      refY: 5,
      markerWidth: 7,
      markerHeight: 7,
      orient: "auto-start-reverse",
    });
  marker.append(
    studioSVG("path", { d: "M0 0 L10 5 L0 10 Z", fill: "#7898b7" }),
  );
  definitions.append(marker);
  graph.append(definitions);
  studioElement("studio-graph-title").textContent =
    `${studioState.workflow} · declared flow`;
  const positions = new Map(
    definition.nodes.map((node, index) => [
      node.id,
      studioPosition(node, index),
    ]),
  );
  const left = Math.min(0, ...[...positions.values()].map((p) => p.x - 15)),
    top = Math.min(0, ...[...positions.values()].map((p) => p.y - 15)),
    width =
      Math.max(650, ...[...positions.values()].map((p) => p.x + 230)) - left,
    height =
      Math.max(420, ...[...positions.values()].map((p) => p.y + 120)) - top;
  graph.setAttribute("viewBox", `${left} ${top} ${width} ${height}`);
  graph.setAttribute("width", String(width));
  graph.setAttribute("height", String(height));
  for (const node of definition.nodes)
    for (const [port, target] of studioEdges(node)) {
      if (!target) continue;
      const from = positions.get(node.id),
        to = positions.get(target);
      if (!from || !to) continue;
      graph.append(
        studioSVG("path", {
          d: `M${from.x + 205},${from.y + 42} C${from.x + 235},${from.y + 42} ${to.x - 30},${to.y + 42} ${to.x},${to.y + 42}`,
          class: "studio-edge",
          "marker-end": "url(#studio-arrow)",
        }),
      );
      graph.append(
        studioSVG(
          "text",
          {
            x: (from.x + 205 + to.x) / 2,
            y: (from.y + to.y) / 2 + 32,
            class: "studio-port",
          },
          port,
        ),
      );
    }
  for (const block of definition.nodes) {
    const position = positions.get(block.id),
      selected = studioState.selected === block.id;
    if (!position) continue;
    const group = studioSVG("g", {
      class: `studio-block${selected ? " selected" : ""}`,
      transform: `translate(${position.x},${position.y})`,
      tabindex: 0,
      role: "button",
      "aria-label": `${block.kind} block ${block.id}`,
      "aria-pressed": selected,
    });
    group.append(
      studioSVG("rect", { width: 205, height: 90, rx: 10 }),
      studioSVG("text", { x: 14, y: 24, class: "studio-kind" }, block.kind),
      studioSVG("text", { x: 14, y: 48 }, block.id),
      studioSVG(
        "text",
        { x: 14, y: 71 },
        block.workflow
          ? `Child: ${block.workflow}`
          : block.profile
            ? `Profile: ${block.profile}`
            : "",
      ),
    );
    const pick = () => {
      studioState.selected = block.id;
      studioRenderGraph();
      studioRenderNode();
    };
    group.addEventListener("click", pick);
    group.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        pick();
        studioElement("studio-node-form").querySelector("input")?.focus();
      }
    });
    graph.append(group);
  }
}
/** @type {Record<string,[string,string,boolean?][]>} */
const studioFields = {
  agent: [
    ["prompt", "multiline"],
    ["profile", "profile"],
    ["context", "json", true],
    ["outputSchema", "json"],
    ["corrections", "number", true],
  ],
  command: [
    ["argv", "json"],
    ["timeoutMs", "number", true],
  ],
  workflow: [
    ["workflow", "workflow"],
    ["input", "json"],
    ["attempt", "number", true],
    ["maxDispatches", "number", true],
    ["timeoutMs", "number", true],
  ],
  branch: [["predicate", "json"]],
  end: [
    ["output", "json"],
    ["passed", "json", true],
  ],
  repeat: [
    ["workflow", "workflow"],
    ["input", "json"],
    ["until", "json"],
    ["maxIterations", "number"],
  ],
  parallel: [
    ["branches", "json"],
    ["join", "join"],
  ],
  custom: [
    ["component", "text"],
    ["input", "json"],
    ["inputSchema", "json"],
    ["outputSchema", "json"],
  ],
};
/** @param {unknown} value @param {string} oldId @param {string} newId */
function studioReplaceReferences(value, oldId, newId) {
  if (Array.isArray(value))
    value.forEach((item) => studioReplaceReferences(item, oldId, newId));
  else if (value && typeof value === "object") {
    const reference = /** @type {Record<string,unknown>} */ (value);
    const prefix = `#/nodes/${oldId}`;
    if (
      typeof reference.$ref === "string" &&
      (reference.$ref === prefix || reference.$ref.startsWith(prefix + "/"))
    )
      reference.$ref = `#/nodes/${newId}` + reference.$ref.slice(prefix.length);
    for (const child of Object.values(value))
      studioReplaceReferences(child, oldId, newId);
  }
}
function studioRenderNode() {
  const form = studioElement("studio-node-form"),
    block = studioNode();
  form.replaceChildren();
  studioElement("studio-child-contract").replaceChildren();
  studioButton("studio-delete").disabled = !block;
  studioElement("studio-node-title").textContent = block
    ? block.id
    : "Select a block";
  if (!block) return;
  studioField(
    form,
    block,
    "id",
    block.id,
    "text",
    (value) => {
      const old = block.id,
        renamed = String(value);
      block.id = renamed;
      studioState.selected = renamed;
      const definition = studioDefinition();
      if (definition.start === old) definition.start = String(value);
      for (const node of definition.nodes)
        for (const key of ["next", "then", "else"])
          if (node[key] === old) node[key] = value;
      studioReplaceReferences(definition.nodes, old, renamed);
      if (definition.layout?.[old]) {
        definition.layout[renamed] = definition.layout[old];
        delete definition.layout[old];
      }
      studioRenderSettings();
    },
    { label: "Block ID" },
  );
  for (const [name, originalType, optional = false] of studioFields[
    block.kind
  ] ?? []) {
    let type = originalType,
      values = /** @type {string[]} */ ([]);
    if (["profile", "workflow", "join"].includes(type)) {
      values =
        type === "profile"
          ? ["", ...Object.keys(studioState.document.profiles ?? {})]
          : type === "workflow"
            ? Object.keys(studioState.document.workflows)
            : ["all", "any"];
      type = "select";
    }
    studioField(
      form,
      block,
      name,
      block[name] ?? (optional && type === "select" ? "" : undefined),
      type,
      (value) => {
        if (value === undefined || (name === "profile" && value === ""))
          delete block[name];
        else block[name] = value;
        if (name === "workflow") studioRenderNode();
      },
      {
        optional,
        values,
        min: ["corrections", "maxDispatches"].includes(name) ? 0 : 1,
        max: name === "corrections" ? 3 : undefined,
        label:
          name === "workflow"
            ? "Child workflow"
            : name === "profile"
              ? "Node profile"
              : name,
      },
    );
  }
  for (const [port, field] of block.kind === "end"
    ? []
    : block.kind === "branch"
      ? [
          ["true", "then"],
          ["false", "else"],
        ]
      : [["next", "next"]])
    studioField(
      form,
      block,
      field,
      block[field],
      "select",
      (value) => {
        block[field] = value;
      },
      {
        values: studioDefinition().nodes.map((node) => node.id),
        label: `${port} target`,
      },
    );
  const position = studioPosition(
    block,
    studioDefinition().nodes.indexOf(block),
  );
  for (const axis of /** @type {const} */ (["x", "y"]))
    studioField(
      form,
      block,
      `layout-${axis}`,
      position[axis],
      "number",
      (value) => {
        const definition = studioDefinition();
        definition.layout ??= {};
        definition.layout[block.id] ??= { ...position };
        definition.layout[block.id][axis] = Number(value);
      },
      { min: -10000, max: 10000, label: `Layout ${axis}` },
    );
  const children = block.workflow
    ? [{ id: block.workflow, workflow: block.workflow }]
    : block.kind === "parallel"
      ? block.branches
      : [];
  for (const child of children ?? []) {
    const definition = studioState.document.workflows[child.workflow];
    const area = studioElement("studio-child-contract");
    area.append(
      studioText("h3", `Child: ${child.id}`),
      studioText(
        "pre",
        definition
          ? studioJSON({
              inputSchema: definition.inputSchema,
              outputSchema: definition.outputSchema,
              defaultProfile: definition.defaultProfile ?? null,
            })
          : "Missing child definition",
      ),
    );
    if (definition) {
      const open = studioText("button", `Open child ${child.workflow}`);
      open.onclick = () => {
        studioState.workflow = child.workflow;
        studioState.selected = definition.start;
        studioRender();
      };
      area.append(open);
    }
  }
}
function studioRenderCatalogue() {
  const area = studioElement("studio-catalogue");
  area.replaceChildren();
  for (const contract of studioState.catalogue) {
    const button = studioText("button");
    button.append(
      studioText("strong", contract.label),
      studioText("small", contract.description),
    );
    button.setAttribute("aria-label", `Add ${contract.kind} block`);
    button.onclick = () => studioAddBlock(contract.kind);
    area.append(button);
  }
}
/** @param {string} kind */
function studioAddBlock(kind) {
  if (!studioWritable()) return;
  const definition = studioDefinition(),
    selected = studioNode();
  let id = kind,
    suffix = 1;
  while (definition.nodes.some((node) => node.id === id)) id = kind + suffix++;
  const terminal = definition.nodes.find((node) => node.kind === "end"),
    target = selected?.next ?? terminal?.id ?? selected?.id ?? id;
  const child =
    Object.keys(studioState.document.workflows).find(
      (name) => name !== studioState.workflow,
    ) ?? "child";
  /** @type {Record<string,Record<string,unknown>>} */
  const defaults = {
    agent: { prompt: "Describe the result", outputSchema: {}, next: target },
    command: { argv: [], next: target },
    workflow: { workflow: child, input: { $ref: "#/input" }, next: target },
    branch: {
      predicate: { left: true, op: "truthy" },
      then: target,
      else: target,
    },
    end: { output: { $ref: "#/input" }, passed: true },
    repeat: {
      workflow: child,
      input: { $ref: "#/input" },
      until: { left: true, op: "truthy" },
      maxIterations: 2,
      next: target,
    },
    parallel: {
      branches: [{ id: "first", workflow: child, input: { $ref: "#/input" } }],
      join: "all",
      next: target,
    },
    custom: {
      component: "component",
      input: { $ref: "#/input" },
      inputSchema: {},
      outputSchema: {},
      next: target,
    },
  };
  const block = { id, kind, ...studioClone(defaults[kind]) };
  if (selected?.kind === "end" && kind !== "end") {
    for (const node of definition.nodes)
      for (const key of ["next", "then", "else"])
        if (node[key] === selected.id) node[key] = id;
    if (definition.start === selected.id) definition.start = id;
  } else if (selected?.next) {
    selected.next = id;
  }
  definition.nodes.push(block);
  studioState.selected = id;
  studioDirty();
  studioRender();
  studioNotice(
    "Block added. Configure its contracts and validate the document.",
  );
}
async function studioValidate() {
  try {
    if (!studioState.sourceDirty)
      for (const [key, draft] of [...studioState.drafts])
        if (!studioApplyField(key, draft))
          throw new Error(
            `Correct the pending ${draft.label} field before validation.`,
          );
    const revision = studioState.revision,
      source = studioState.sourceDirty
        ? studioControl("studio-source").value
        : studioJSON(studioState.document);
    studioElement("studio-status").textContent = "Validating…";
    studioButton("studio-download").disabled = true;
    const response = await fetch("/studio/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source }),
    });
    const result = await response.json();
    if (revision !== studioState.revision) return;
    if (!response.ok) throw new Error(result.error ?? response.statusText);
    studioState.document = studioClone(result.document);
    studioState.sourceDirty = false;
    studioState.drafts.clear();
    if (!studioState.document.workflows[studioState.workflow])
      studioState.workflow = result.document.root;
    if (!studioNode()) studioState.selected = studioDefinition().start;
    studioState.catalogue = result.catalogue;
    studioState.yaml = result.yaml;
    studioState.validated = revision;
    studioButton("studio-download").disabled = false;
    studioElement("studio-status").textContent = "Document valid";
    studioElement("studio-identity").textContent =
      `Semantic identity ${result.identity}`;
    studioNotice(
      result.warnings.length
        ? result.warnings.join(" · ")
        : "Document valid. Execution still requires local target preflight.",
      "success",
    );
    studioRenderCatalogue();
    studioRender();
  } catch (error) {
    studioDirty();
    studioNotice(
      error instanceof Error ? error.message : String(error),
      "error",
    );
  }
}
studioElement("studio-new").onclick = () => {
  studioLoad(studioNewDocument());
  void studioValidate();
};
studioElement("studio-file").onchange = async () => {
  const input = studioControl("studio-file");
  const file = input instanceof HTMLInputElement ? input.files?.[0] : undefined;
  if (!file) return;
  // A user can reopen the same file after a rejected source draft.
  input.value = "";
  studioDirty();
  if (file.size > 900 * 1024)
    return studioNotice(
      "Source file exceeds the editor's 900 KiB import limit.",
      "error",
    );
  const revision = studioState.revision,
    text = await file.text();
  if (revision !== studioState.revision) return;
  studioControl("studio-source").value = text;
  studioState.sourceDirty = true;
  await studioValidate();
};
studioElement("studio-definition").onchange = () => {
  studioState.workflow = studioControl("studio-definition").value;
  studioState.selected = studioDefinition().start;
  studioRender();
};
studioElement("studio-root").onchange = () => {
  if (!studioWritable()) return;
  studioState.document.root = studioControl("studio-root").value;
  studioDirty();
  studioSource();
};
studioElement("studio-add-child").onclick = () => {
  if (!studioWritable()) return;
  const name = studioControl("studio-child-name").value.trim();
  if (
    !/^[A-Za-z][A-Za-z0-9_.-]*$/.test(name) ||
    Object.hasOwn(studioState.document.workflows, name)
  )
    return studioNotice(
      "Enter a new child name that starts with a letter.",
      "error",
    );
  studioState.document.workflows[name] = studioNewDefinition();
  studioDirty();
  studioRender();
  studioNotice(
    "Child added. Connect it with a workflow, repeat, or parallel block.",
  );
};
studioButton("studio-delete").onclick = () => {
  const block = studioNode();
  if (!studioWritable() || !block) return;
  const definition = studioDefinition(),
    scope = studioScope(block);
  for (const key of studioState.drafts.keys())
    if (key.startsWith(`${scope}:`)) studioState.drafts.delete(key);
  definition.nodes = definition.nodes.filter((node) => node !== block);
  if (definition.layout) delete definition.layout[block.id];
  studioState.selected = definition.nodes[0]?.id ?? "";
  studioDirty();
  studioRender();
  studioNotice(
    "Block removed. Repair start and transitions before validation.",
  );
};
studioElement("studio-arrange").onclick = () => {
  if (!studioWritable()) return;
  const definition = studioDefinition();
  definition.layout = Object.fromEntries(
    definition.nodes.map((node, index) => [
      node.id,
      { x: 30 + (index % 3) * 270, y: 35 + Math.floor(index / 3) * 160 },
    ]),
  );
  studioDirty();
  studioRender();
};
studioControl("studio-source").oninput = () => {
  studioState.sourceDirty = true;
  studioDirty();
};
studioElement("studio-apply-source").onclick = studioValidate;
studioElement("studio-validate").onclick = studioValidate;
for (const id of ["studio-workflow-form", "studio-node-form"])
  studioElement(id).addEventListener("submit", (event) =>
    event.preventDefault(),
  );
studioButton("studio-download").onclick = () => {
  if (
    studioState.validated !== studioState.revision ||
    studioState.sourceDirty ||
    studioState.drafts.size
  )
    return studioNotice("Validate the current draft before download.", "error");
  const format = studioControl("studio-format").value,
    text =
      format === "yaml" ? studioState.yaml : studioJSON(studioState.document);
  const url = URL.createObjectURL(
    new Blob([text], {
      type: format === "yaml" ? "application/yaml" : "application/json",
    }),
  );
  const link = studioText("a");
  link.href = url;
  link.download = `workflow.${format}`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
};
studioLoad(studioNewDocument());
void studioValidate();
