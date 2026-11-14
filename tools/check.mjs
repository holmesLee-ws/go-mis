#!/usr/bin/env node
// 리포 관리자용 검사기. 학습자에게는 필요 없다.
// 검사: 커리큘럼 형식·선수 관계(R2), 국내 근거·글로벌 비교 칸과 출처 꼬리표(R10·R11), 겹침 경계 표(R13),
// 미리 만든 시각 자료 없음(R5), 설정 JSON 유효성.
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];
const read = (p) => readFileSync(join(root, p), "utf8").replace(/\r\n/g, "\n");

const LEVELS = ["Explain", "Apply", "Evaluate", "Develop"];
const FIELDS = ["선수", "핵심 질문", "목표", "만들어 볼 것", "국내 근거", "글로벌 비교"];
const REQUIRED_ALLOW = ["Edit(/learner/state.json)", "Edit(/learner/log.md)", "Edit(/learner/studio/**/*.html)", "Edit(/learner/work/**/*.md)", "WebSearch", "WebFetch", "Bash(open learner/studio/*.html)", "Bash(xdg-open learner/studio/*.html)", "Bash(start \"\" learner/studio/*.html)", "PowerShell(Start-Process learner/studio/*.html)"];
const NO_LAW = "국내 법령 직접 근거 없음";
// 공공·금융 조직에만 의무인 국내 출처와, 그 조직 자체를 다루는 모듈(민간 표시 예외).
const SECTOR = ["S1", "S2", "S3", "S4", "S9", "S10", "S12", "S13", "S14", "S15", "S16", "S21"];
const SECTOR_MODULES = ["P5", "G6", "X1"];
const AREAS = ["F", "G", "A", "P", "O", "X"];
// R11 공식 출처 도메인(spec.md R11). 새 기관을 쓰면 여기와 spec을 함께 고친다.
const OFFICIAL = ["law.go.kr", "go.kr", "nia.or.kr", "nipa.kr", "fss.or.kr", "kisa.or.kr", "tta.or.kr", "swai.or.kr", "iso.org", "isaca.org", "opengroup.org", "peoplecert.org", "dama.org", "nist.gov", "europa.eu", "govinfo.gov", "gov.uk", "un.org", "acm.org", "finops.org"];

function parseCurriculum(text) {
  const modules = new Map();
  const problems = [];
  const cited = [];
  const boundaryRefs = [];
  const body = text.split(/^## 출처/m)[0];
  const blocks = body.split(/^### /m).slice(1);
  for (const block of blocks) {
    const lines = block.split("\n");
    const end = lines.findIndex((l) => l.startsWith("## "));
    const own = end === -1 ? lines : lines.slice(0, end);
    const head = own[0];
    const m = head.match(/^([FGAPOX]\d+) · (.+)$/);
    if (!m) { problems.push(`모듈 제목 형식 오류: ${head}`); continue; }
    const id = m[1];
    if (modules.has(id)) problems.push(`${id}: 중복 id`);
    const fields = {};
    for (const line of own.slice(1)) {
      if (!line.trim()) continue;
      const f = line.match(/^- ([^:]+): (.+)$/);
      if (!f || ![...FIELDS, "경계·연결"].includes(f[1])) { problems.push(`${id}: 정해진 칸 밖의 줄(본문 금지): ${line.slice(0, 40)}`); continue; }
      fields[f[1]] = f[2];
      if (f[1] === "경계·연결") for (const g of f[2].matchAll(/go-[a-z-]+/g)) boundaryRefs.push([id, g[0]]);
    }
    for (const name of FIELDS) if (!fields[name]) problems.push(`${id}: 「${name}」 없음`);
    if (fields["목표"] && !LEVELS.some((l) => fields["목표"].startsWith(`${l} — `))) problems.push(`${id}: 목표 수준 형식 오류`);
    for (const name of ["국내 근거", "글로벌 비교"]) {
      const v = fields[name];
      if (!v) continue;
      const tags = [...v.matchAll(/\[(S\d+)\]/g)].map((x) => x[1]);
      if (tags.length === 0 && !(name === "국내 근거" && v.includes(NO_LAW))) problems.push(`${id}: 「${name}」에 출처 꼬리표 없음`);
      for (const t of tags) {
        cited.push([id, t]);
        const n = Number(t.slice(1));
        if (name === "국내 근거" && n >= 30) problems.push(`${id}: 국내 근거 칸이 해외 출처 ${t}를 가리킴`);
        if (name === "국내 근거" && SECTOR.includes(t) && !SECTOR_MODULES.includes(id) && !/(공공|금융회사): [^]*$/.test(v.slice(0, v.indexOf(`[${t}]`)))) problems.push(`${id}: 공공·금융 전용 출처 ${t} 앞에 「공공:」·「금융회사:」 표시가 없음`);
        if (name === "글로벌 비교" && n < 30) problems.push(`${id}: 글로벌 비교 칸이 국내 출처 ${t}를 가리킴`);
      }
    }
    if (/제\d+조/.test(block)) problems.push(`${id}: 지도에 조문 번호를 쓰지 않는다`);
    const prereq = !fields["선수"] || fields["선수"] === "없음" ? [] : fields["선수"].split(",").map((s) => s.trim());
    modules.set(id, prereq);
  }
  for (const [id, prereq] of modules) for (const p of prereq) if (!modules.has(p)) problems.push(`${id}: 없는 선수 ${p}`);
  const state = new Map();
  const visit = (id, path) => {
    if (state.get(id) === 2 || !modules.has(id)) return;
    if (state.get(id) === 1) { problems.push(`선수 순환: ${[...path, id].join(" → ")}`); return; }
    state.set(id, 1);
    for (const p of modules.get(id)) visit(p, [...path, id]);
    state.set(id, 2);
  };
  for (const id of modules.keys()) visit(id, []);
  const sources = new Map();
  const srcPart = text.split(/^## 출처/m)[1] || "";
  for (const line of srcPart.split("\n")) {
    const c = line.split("|").map((x) => x.trim());
    if (!/^S\d+$/.test(c[1] || "")) continue;
    if (sources.has(c[1])) problems.push(`출처 ${c[1]}: 중복`);
    sources.set(c[1], c);
    if (!/^https:\/\//.test(c[4] || "")) problems.push(`출처 ${c[1]}: URL 없음`);
    else if (!OFFICIAL.some((d) => { const h = new URL(c[4]).hostname; return h === d || h.endsWith("." + d); })) problems.push(`출처 ${c[1]}: 공식 출처 도메인 목록 밖 ${new URL(c[4]).hostname}`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(c[5] || "")) problems.push(`출처 ${c[1]}: 조회일 없음(${c[5] || ""})`);
  }
  if (sources.size === 0) problems.push("출처 표를 찾지 못함");
  for (const [id, t] of cited) if (!sources.has(t)) problems.push(`${id}: 출처 표에 없는 꼬리표 ${t}`);
  const used = new Set(cited.map((x) => x[1]));
  for (const t of sources.keys()) if (!used.has(t)) problems.push(`출처 ${t}: 어느 모듈도 쓰지 않음`);
  const bPart = (text.split(/^## 겹침 경계/m)[1] || "").split(/^## /m)[0];
  if (!bPart) problems.push("겹침 경계 표 없음");
  for (const [id, g] of boundaryRefs) if (!bPart.includes(`| ${g} |`)) problems.push(`${id}: 경계 표에 없는 영역 ${g}`);
  for (const a of AREAS) if (![...modules.keys()].some((k) => k.startsWith(a))) problems.push(`영역 ${a} 모듈 없음`);
  return { modules, problems, sources };
}

function findVisualAssets(files) {
  const allowedJs = /^tools\/[^/]*\.mjs$/;
  return files.filter((f) => /\.(html?|css|svg|png|jpe?g|gif|webp|avif|ico|bmp|tiff?)$/i.test(f) || (/\.m?js$/i.test(f) && !allowedJs.test(f)));
}

function findTemplateMarkup(name, text) {
  const hits = [];
  for (const m of text.matchAll(/(```|~~~)[\s\S]*?\1/g)) if (/<(!doctype|html|svg|style|canvas|script)\b/i.test(m[0])) hits.push(name);
  return hits;
}

function main() {
  const { modules, problems, sources } = parseCurriculum(read("curriculum/map.md"));
  if (!existsSync(join(root, "tutor/sources.md"))) errors.push("tutor/sources.md 없음");
  errors.push(...problems);
  if (modules.size === 0) errors.push("모듈을 찾지 못함");

  const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
  for (const f of findVisualAssets(files)) errors.push(`미리 만든 시각 자료 금지: ${f}`);
  for (const f of files.filter((x) => x.endsWith(".md") && existsSync(join(root, x)))) for (const n of findTemplateMarkup(f, read(f))) errors.push(`복사용 마크업 금지: ${n}`);

  for (const p of [".claude/settings.json", "learner-template/state.json"]) {
    try { JSON.parse(read(p)); } catch (e) { errors.push(`${p}: JSON 오류 ${e.constructor.name}`); }
  }
  if (!existsSync(join(root, "learner-template/log.md"))) errors.push("learner-template/log.md 없음");
  for (const s of readdirSync(join(root, ".claude/skills"))) {
    if (statSync(join(root, ".claude/skills", s)).isDirectory() && !existsSync(join(root, ".claude/skills", s, "SKILL.md"))) errors.push(`스킬 ${s}: SKILL.md 없음`);
  }
  const allow = (() => { try { return JSON.parse(read(".claude/settings.json")).permissions?.allow || []; } catch { return []; } })();
  for (const rule of REQUIRED_ALLOW) if (!allow.includes(rule)) errors.push(`settings.json allow에 필수 규칙 없음(R9): ${rule}`);
  if (!read(".gitignore").split("\n").includes("learner/")) errors.push(".gitignore에 learner/ 없음");

  if (errors.length) { console.error(errors.map((e) => `FAIL ${e}`).join("\n")); process.exit(1); }
  console.log(`OK 모듈 ${modules.size}개, 출처 ${sources.size}개, 파일 ${files.length}개 검사`);
}

main();
