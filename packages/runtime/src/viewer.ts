import { createServer, type Server, type ServerResponse } from "node:http";
import { tokenCostReport, type RunEvent } from "@graphcraft/core";
import { RunStore } from "./store.ts";
import { redactString, redactValue } from "./redaction.ts";

const LOOPBACK_HOST = "127.0.0.1";
const MAX_ARTIFACT_BYTES = 1024 * 1024;

function compactEventData(event: RunEvent): Record<string, unknown> {
  const data = event.data;
  const selected = [
    "nodeId",
    "classification",
    "summary",
    "reason",
    "batchId",
    "actionId",
    "outcome",
    "nextWakeAt",
    "previousBaseSha",
    "baseSha",
    "kind",
    "strategy",
    "verdict",
    "status",
    "termination",
    "progressDecision",
    "decisionPacket",
    "packet",
  ];
  const compact = Object.fromEntries(
    selected.filter((key) => data[key] !== undefined).map((key) => [key, data[key]]),
  );
  if (Array.isArray(data.evidence))
    compact.evidence = data.evidence.slice(0, 10).map((item) => String(item).slice(0, 1_000));
  return redactValue(compact) as Record<string, unknown>;
}

type ViewerProjection = [
  Awaited<ReturnType<RunStore["loadContract"]>>,
  Awaited<ReturnType<RunStore["loadGraph"]>>,
  Awaited<ReturnType<RunStore["loadState"]>>,
  RunEvent[],
  Awaited<ReturnType<RunStore["loadGraphHistory"]>>,
  Awaited<ReturnType<RunStore["loadProbePlan"]>>,
  Awaited<ReturnType<RunStore["loadArtifactInventory"]>>,
];

export async function createViewerSnapshot(store: RunStore): Promise<Record<string, unknown>> {
  let projection: ViewerProjection | undefined;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = await store.loadEvents();
    const [contract, graph, state, graphHistory, probePlan, artifactInventory] = await Promise.all([
      store.loadContract(),
      store.loadGraph(),
      store.loadState(),
      store.loadGraphHistory(),
      store.loadProbePlan(),
      store.loadArtifactInventory(),
    ]);
    const events = await store.loadEvents();
    const beforeRevision = `${before.length}:${before.at(-1)?.hash ?? "empty"}`;
    const afterRevision = `${events.length}:${events.at(-1)?.hash ?? "empty"}`;
    if (beforeRevision === afterRevision) {
      projection = [contract, graph, state, events, graphHistory, probePlan, artifactInventory];
      break;
    }
  }
  if (!projection)
    throw new Error("Durable run state changed too often to build one consistent viewer snapshot");
  const [contract, graph, state, events, graphHistory, probePlan, artifactInventory] = projection;
  const artifacts = artifactInventory.entries
    .filter(({ path }) => path.startsWith("artifacts/"))
    .map((entry) => {
      const path = entry.path.slice("artifacts/".length);
      return {
        path,
        size: entry.storedBytes,
        kind: entry.kind,
        format: entry.format,
        sourceBytes: entry.sourceBytes,
        storedBytes: entry.storedBytes,
        omittedBytes: entry.omittedBytes,
        truncated: entry.truncated,
        disposition: entry.disposition,
        legacy: entry.legacy,
        ...(entry.reason ? { reason: entry.reason } : {}),
        ...(entry.storedHash
          ? { href: `/artifacts/${path.split("/").map(encodeURIComponent).join("/")}` }
          : {}),
      };
    });
  const progressByNode = new Map<string, RunEvent>();
  const contextByNode = new Map<string, Record<string, unknown>>();
  for (const event of events) {
    if (event.type === "node.progress" && typeof event.data.nodeId === "string")
      progressByNode.set(event.data.nodeId, event);
    if (event.type === "context.selected") {
      const receipt = event.data.receipt;
      if (receipt && typeof receipt === "object" && !Array.isArray(receipt)) {
        const value = receipt as Record<string, unknown>;
        if (typeof value.nodeId === "string")
          contextByNode.set(value.nodeId, {
            selectedPaths: value.selectedPaths,
            omittedPredecessorIds: value.omittedPredecessorIds,
            omittedProbeIds: value.omittedProbeIds,
            capsuleCharacters: value.capsuleCharacters,
            capsuleReused: value.capsuleReused,
            repositoryInventoryReused: value.repositoryInventoryReused,
          });
      }
    }
  }
  const nodes = graph.nodes.map((node) => ({
    id: node.id,
    kind: node.kind,
    objective: redactString(node.objective),
    status: state.nodes[node.id]?.status ?? node.status,
    attempts: state.nodes[node.id]?.attempts ?? 0,
    current: state.currentNodeId === node.id,
    scope: node.scope,
    sideEffectClass: node.sideEffectClass,
    dependsOn: node.dependsOn,
    context: contextByNode.get(node.id) ?? {
      selectedPaths: node.contextSelector.relevantPaths,
      predecessorResults: node.contextSelector.predecessorResults,
    },
    progressProbes: node.progressProbes,
    completionProbes: node.completionProbes,
    evidence: progressByNode.get(node.id)
      ? compactEventData(progressByNode.get(node.id)!).evidence
      : [],
    tokens: state.tokenLedger.filter(({ nodeId }) => nodeId === node.id),
    sideEffects: state.sideEffects.filter(({ claim }) => claim.nodeId === node.id),
  }));
  const timeline = events.map((event) => ({
    sequence: event.sequence,
    timestamp: event.timestamp,
    actor: event.actor,
    type: event.type,
    causationId: event.causationId,
    category: event.type.startsWith("side_effect.")
      ? "side_effect"
      : event.type === "scope.checked"
        ? "scope"
        : event.type.startsWith("graph.")
          ? "graph"
          : event.type.startsWith("tokens.")
            ? "tokens"
            : event.type.startsWith("wait.") ||
                event.type.startsWith("invocation.") ||
                event.type === "node.reset" ||
                event.type === "run.paused" ||
                event.type === "run.stopped" ||
                event.type === "control.applied"
              ? "recovery"
              : event.actor,
    data: compactEventData(event),
  }));
  return redactValue({
    schemaVersion: 1,
    readOnly: true,
    source: "verified durable run files",
    generatedAt: new Date().toISOString(),
    run: {
      id: state.runId,
      task: contract.task,
      outcome: contract.outcome,
      finishLine: contract.finishLine.kind,
      status: state.status,
      stopReason: state.stopReason,
      updatedAt: state.updatedAt,
      currentNodeId: state.currentNodeId,
    },
    anchors: contract.acceptanceAnchors,
    nodes,
    workEdges: graph.nodes.flatMap((node) =>
      node.dependsOn.map((from) => ({ from, to: node.id, relation: "depends_on" })),
    ),
    controlEdges: graph.controlEdges,
    probePlan,
    revisions: graphHistory,
    timeline,
    tokenReport: tokenCostReport(state.tokenLedger),
    waits: state.waits,
    sideEffects: state.sideEffects,
    decision: state.pendingDecision,
    artifactInventory,
    artifacts,
  }) as Record<string, unknown>;
}

function send(
  response: ServerResponse,
  status: number,
  body: string | Uint8Array,
  contentType: string,
): void {
  response.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy":
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  });
  response.end(body);
}

export interface RunViewer {
  url: string;
  host: typeof LOOPBACK_HOST;
  port: number;
  server: Server;
  close: () => Promise<void>;
}

export async function startRunViewer(input: {
  store: RunStore;
  port?: number;
}): Promise<RunViewer> {
  const port = input.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65_535)
    throw new Error("Viewer port must be an integer from 0 through 65535");
  let expectedAuthority: string | undefined;
  const server = createServer(async (request, response) => {
    try {
      if (!expectedAuthority || request.headers.host !== expectedAuthority) {
        send(response, 421, "Viewer authority rejected\n", "text/plain; charset=utf-8");
        return;
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        send(response, 405, "Read-only viewer\n", "text/plain; charset=utf-8");
        return;
      }
      const url = new URL(request.url ?? "/", `http://${LOOPBACK_HOST}`);
      if (url.pathname === "/") {
        send(response, 200, VIEWER_HTML, "text/html; charset=utf-8");
        return;
      }
      if (url.pathname === "/api/snapshot" || url.pathname === "/api/export") {
        const snapshot = await createViewerSnapshot(input.store);
        send(
          response,
          200,
          `${JSON.stringify(snapshot, null, url.pathname === "/api/export" ? 2 : 0)}\n`,
          "application/json; charset=utf-8",
        );
        return;
      }
      if (url.pathname.startsWith("/artifacts/")) {
        const relativePath = decodeURIComponent(url.pathname.slice("/artifacts/".length));
        const preview = await input.store.readArtifactPreview(relativePath, MAX_ARTIFACT_BYTES);
        const text = preview.bytes.toString("utf8");
        response.setHeader("x-graphcraft-truncated", String(preview.truncated));
        response.setHeader("x-graphcraft-original-bytes", String(preview.originalBytes));
        send(
          response,
          200,
          `${redactString(text)}${preview.truncated ? "\n[TRUNCATED]\n" : ""}`,
          "text/plain; charset=utf-8",
        );
        return;
      }
      send(response, 404, "Not found\n", "text/plain; charset=utf-8");
    } catch (error) {
      void error;
      send(response, 500, "Viewer read failed\n", "text/plain; charset=utf-8");
    }
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, LOOPBACK_HOST, () => {
      server.off("error", reject);
      resolveListen();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Viewer did not bind a TCP port");
  expectedAuthority = `${LOOPBACK_HOST}:${address.port}`;
  const url = `http://${LOOPBACK_HOST}:${address.port}/`;
  return {
    url,
    host: LOOPBACK_HOST,
    port: address.port,
    server,
    close: async () =>
      await new Promise<void>((resolveClose, reject) =>
        server.close((error) => (error ? reject(error) : resolveClose())),
      ),
  };
}

const VIEWER_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Graphcraft run viewer</title>
  <style>
    :root{color-scheme:light dark;--bg:#f5f7fb;--panel:#fff;--text:#182033;--muted:#62708a;--line:#cbd4e4;--accent:#315cf5;--control:#a64ac9;--good:#147d50;--bad:#ba2d3b;--wait:#9a6500} @media(prefers-color-scheme:dark){:root{--bg:#10131b;--panel:#191e2a;--text:#edf1fa;--muted:#aab4ca;--line:#384156;--accent:#84a3ff;--control:#d594ef;--good:#62d49c;--bad:#ff7e89;--wait:#f0bd58}}
    *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 ui-sans-serif,system-ui,sans-serif}header{position:sticky;top:0;z-index:3;background:color-mix(in srgb,var(--panel) 92%,transparent);backdrop-filter:blur(10px);border-bottom:1px solid var(--line);padding:14px 20px;display:flex;gap:18px;align-items:center;flex-wrap:wrap}h1{font-size:18px;margin:0}.meta{color:var(--muted)}.badge{border:1px solid var(--line);border-radius:999px;padding:3px 9px}.tabs{display:flex;gap:6px;margin-left:auto}.tabs button,.filters button,.download{border:1px solid var(--line);background:var(--panel);color:var(--text);border-radius:7px;padding:7px 10px;cursor:pointer}.tabs button[aria-selected=true],.filters button.active{border-color:var(--accent);color:var(--accent)}main{padding:18px;max-width:1500px;margin:auto}.view{display:none}.view.active{display:block}.grid{display:grid;grid-template-columns:minmax(0,2fr) minmax(280px,1fr);gap:16px}.panel{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px;min-width:0}.panel h2{font-size:15px;margin:0 0 12px}.graph-scroll{overflow:auto;min-height:480px}svg{min-width:900px;width:100%;height:620px}.edge{stroke:var(--line);stroke-width:2}.edge.control{stroke:var(--control);stroke-dasharray:7 5}.edge.depends{stroke:var(--accent)}.node rect{fill:var(--panel);stroke:var(--line);stroke-width:2;rx:10}.node.current rect{stroke:var(--accent);stroke-width:4}.node.failed rect{stroke:var(--bad)}.node.accepted rect{stroke:var(--good)}.node.waiting rect{stroke:var(--wait)}.node text{fill:var(--text);pointer-events:none}.node{cursor:pointer}.node:focus rect{outline:none;stroke:var(--accent);stroke-width:4}.legend{display:flex;gap:14px;color:var(--muted);flex-wrap:wrap}.swatch{display:inline-block;width:26px;border-top:3px solid var(--accent);vertical-align:middle;margin-right:5px}.swatch.control{border-color:var(--control);border-top-style:dashed}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:color-mix(in srgb,var(--bg) 75%,var(--panel));padding:12px;border-radius:8px;max-height:520px;overflow:auto}.timeline{display:grid;gap:7px}.event{border-left:3px solid var(--line);padding:8px 10px;background:var(--panel);border-radius:0 8px 8px 0}.event.side_effect{border-color:var(--control)}.event.recovery{border-color:var(--wait)}.event.graph{border-color:var(--accent)}.event small{color:var(--muted)}.filters{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px}.token-row{display:grid;grid-template-columns:180px 1fr 90px;gap:8px;align-items:center;margin:8px 0}.bar{height:12px;background:var(--line);border-radius:6px;overflow:hidden}.bar i{display:block;height:100%;background:var(--accent)}.artifact-list{display:grid;gap:6px}.artifact-list a{color:var(--accent)}.empty{color:var(--muted)}@media(max-width:850px){.grid{grid-template-columns:1fr}.tabs{order:3;width:100%;overflow:auto}main{padding:10px}}
  </style>
</head>
<body><header><h1>Graphcraft</h1><span id="run-meta" class="meta">Loading durable state…</span><span id="status" class="badge"></span><nav class="tabs" aria-label="Viewer sections"><button aria-selected="true" data-view="graph">Graph</button><button aria-selected="false" data-view="timeline">Timeline</button><button aria-selected="false" data-view="revisions">Revisions</button><button aria-selected="false" data-view="tokens">Tokens</button><button aria-selected="false" data-view="artifacts">Artifacts</button></nav></header>
<main><section id="graph" class="view active"><div class="grid"><div class="panel"><h2>Work and control graph</h2><div class="legend"><span><i class="swatch"></i>dependency</span><span><i class="swatch control"></i>control</span></div><div class="graph-scroll"><svg id="graph-svg" role="img" aria-label="Execution and governance graph"></svg></div></div><aside class="panel"><h2>Node evidence</h2><pre id="node-detail" tabindex="0">Select a node. Arrow keys move between nodes.</pre></aside></div></section>
<section id="timeline" class="view"><div class="panel"><h2>Durable event timeline</h2><div id="filters" class="filters"></div><div id="event-list" class="timeline"></div></div></section>
<section id="revisions" class="view"><div class="panel"><h2>Graph revisions</h2><div id="revision-list"></div></div></section>
<section id="tokens" class="view"><div class="panel"><h2>Token cost by phase</h2><div id="token-list"></div></div></section>
<section id="artifacts" class="view"><div class="panel"><h2>Local artifacts</h2><p class="meta">Redacted before bounded storage. Source, stored, and omitted byte counts come from the durable artifact inventory.</p><div id="artifact-summary" class="meta"></div><div id="artifact-list" class="artifact-list"></div><p><a class="download" href="/api/export" download="graphcraft-run-report.json">Export redacted run report</a></p></div></section></main>
<script>
const $=id=>document.getElementById(id), ns='http://www.w3.org/2000/svg'; let snapshot, selected, filter='all';
const el=(name,attrs={})=>{const n=document.createElementNS(ns,name);for(const[k,v]of Object.entries(attrs))n.setAttribute(k,String(v));return n};
function show(name){document.querySelectorAll('.view').forEach(v=>v.classList.toggle('active',v.id===name));document.querySelectorAll('.tabs button').forEach(b=>b.setAttribute('aria-selected',String(b.dataset.view===name)))}
document.querySelectorAll('.tabs button').forEach(b=>b.onclick=()=>show(b.dataset.view));
function renderGraph(){const svg=$('graph-svg');svg.textContent='';const nodes=[...snapshot.anchors.map(a=>({id:a.id,kind:'anchor',objective:a.description,status:'anchor',attempts:0,scope:[],sideEffectClass:'none'})),...snapshot.nodes];const levels=new Map();const level=id=>{if(levels.has(id))return levels.get(id);const n=snapshot.nodes.find(n=>n.id===id);const value=n?1+Math.max(-1,...n.dependsOn.map(level)):0;levels.set(id,value);return value};snapshot.nodes.forEach(n=>level(n.id));snapshot.anchors.forEach(a=>levels.set(a.id,0));const groups={};nodes.forEach(n=>(groups[levels.get(n.id)||0]??=[]).push(n));const pos=new Map();Object.entries(groups).forEach(([l,items])=>items.forEach((n,i)=>pos.set(n.id,{x:70+Number(l)*250,y:55+i*105})));const edges=[...snapshot.workEdges.map(e=>({...e,type:'depends'})),...snapshot.controlEdges.map(e=>({...e,type:'control'}))];edges.forEach(e=>{const a=pos.get(e.from),b=pos.get(e.to);if(!a||!b)return;svg.append(el('line',{x1:a.x+170,y1:a.y+34,x2:b.x,y2:b.y+34,class:'edge '+e.type,'aria-label':e.relation}))});nodes.forEach((n,index)=>{const p=pos.get(n.id),g=el('g',{class:'node '+n.status+(n.current?' current':''),tabindex:'0',role:'button','aria-label':n.id+', '+n.kind+', '+n.status,'data-index':index});g.append(el('rect',{x:p.x,y:p.y,width:170,height:68}));const title=el('text',{x:p.x+10,y:p.y+25});title.textContent=n.id.slice(0,24);g.append(title);const sub=el('text',{x:p.x+10,y:p.y+48,'font-size':'12'});sub.textContent=(n.kind+' · '+n.status).slice(0,28);g.append(sub);g.onclick=()=>selectNode(n.id);g.onkeydown=e=>{if(!['ArrowRight','ArrowDown','ArrowLeft','ArrowUp'].includes(e.key))return;e.preventDefault();const next=(index+(e.key==='ArrowRight'||e.key==='ArrowDown'?1:-1)+nodes.length)%nodes.length;svg.querySelector('[data-index="'+next+'"]')?.focus();selectNode(nodes[next].id)};svg.append(g)});const maxLevel=Math.max(1,...levels.values());svg.setAttribute('viewBox','0 0 '+Math.max(900,120+maxLevel*250)+' '+Math.max(620,120+Math.max(...Object.values(groups).map(x=>x.length))*105));if(!selected&&snapshot.nodes[0])selectNode(snapshot.nodes[0].id)}
function selectNode(id){selected=id;const n=snapshot.nodes.find(n=>n.id===id)||snapshot.anchors.find(n=>n.id===id);$('node-detail').textContent=JSON.stringify(n,null,2)}
function renderTimeline(){const categories=['all',...new Set(snapshot.timeline.map(e=>e.category))];$('filters').textContent='';categories.forEach(c=>{const b=document.createElement('button');b.textContent=c;b.className=c===filter?'active':'';b.onclick=()=>{filter=c;renderTimeline()};$('filters').append(b)});$('event-list').textContent='';snapshot.timeline.filter(e=>filter==='all'||e.category===filter).forEach(e=>{const d=document.createElement('div');d.className='event '+e.category;const title=document.createElement('div');title.textContent=e.sequence+'. '+e.type;const meta=document.createElement('small');meta.textContent=e.timestamp+' · '+e.actor;const pre=document.createElement('pre');pre.textContent=JSON.stringify(e.data,null,2);d.append(title,meta,pre);$('event-list').append(d)})}
function renderRevisions(){const root=$('revision-list');root.textContent='';if(!snapshot.revisions.length){root.textContent='No amendments. Revision 1 is the approved graph.';root.className='empty';return}snapshot.revisions.forEach(r=>{const p=document.createElement('pre');p.textContent=JSON.stringify(r,null,2);root.append(p)})}
function renderTokens(){const root=$('token-list');root.textContent='';const report=snapshot.tokenReport||{};const groups=[['Cumulative',{all:report.totals||{}}],['By phase',report.byPhase||{}],['By node',report.byNode||{}]];const all=groups.flatMap(([,rows])=>Object.values(rows));const max=Math.max(1,...all.map(v=>v.total||0));if(!report.receipts){root.textContent='No token receipts.';root.className='empty';return}groups.forEach(([heading,rows])=>{const h=document.createElement('h3');h.textContent=heading;root.append(h);Object.entries(rows).forEach(([name,value])=>{const row=document.createElement('div');row.className='token-row';const label=document.createElement('span');label.textContent=name;const bar=document.createElement('div');bar.className='bar';const fill=document.createElement('i');fill.style.width=100*(value.total||0)/max+'%';bar.append(fill);const number=document.createElement('code');number.textContent='cached '+(value.cachedInput||0)+' · uncached '+(value.uncachedInput||0)+' · output '+(value.output||0)+' · reasoning '+(value.reasoning||0)+' · total '+(value.total||0);row.append(label,bar,number);root.append(row)})})}
function renderArtifacts(){const root=$('artifact-list'),inventory=snapshot.artifactInventory;$('artifact-summary').textContent=inventory?'Stored '+inventory.storedBytes+' of '+inventory.sourceBytes+' source bytes; '+inventory.omittedBytes+' omitted.':'';root.textContent='';if(!snapshot.artifacts.length){root.textContent='No artifacts.';root.className='empty';return}snapshot.artifacts.forEach(a=>{const item=a.href?document.createElement('a'):document.createElement('span');if(a.href){item.href=a.href;item.target='_blank';item.rel='noopener'}const omitted=a.omittedBytes?' · '+a.omittedBytes+' omitted':'';item.textContent=a.path+' ('+a.storedBytes+'/'+a.sourceBytes+' bytes'+omitted+(a.reason?' · '+a.reason:'')+')';root.append(item)})}
function render(){const r=snapshot.run;$('run-meta').textContent=r.task+' · '+r.finishLine+' · '+r.id;$('status').textContent=r.status;renderGraph();renderTimeline();renderRevisions();renderTokens();renderArtifacts()}
async function refresh(){try{const response=await fetch('/api/snapshot',{cache:'no-store'});if(!response.ok)throw new Error(await response.text());const next=await response.json();const changed=!snapshot||snapshot.run.updatedAt!==next.run.updatedAt||snapshot.timeline.length!==next.timeline.length;snapshot=next;if(changed)render()}catch(error){$('run-meta').textContent='Viewer refresh failed: '+error.message}}
refresh();setInterval(refresh,1500);
</script></body></html>`;
