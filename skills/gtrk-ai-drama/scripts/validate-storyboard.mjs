#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { basename } from "node:path";

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("用法：bun scripts/validate-storyboard.mjs <分镜稿.md> [...]");
  process.exit(2);
}

function firstMatchIndex(text, re) {
  const m = re.exec(text);
  return m ? m.index : -1;
}

function validate(md, file) {
  const errors = [];
  const beat = md.match(/[（(]\s*beat\s+([A-Za-z0-9_-]+)\s*[）)]/i)?.[1] ?? "";
  if (!beat) errors.push("H1 标题缺少「（beat BXX）」");

  const meta = md.match(/^[-*]\s*区间总时长\s*[:：]\s*track_st\s+(-?\d+(?:\.\d+)?)\s*→\s*track_ed\s+(-?\d+(?:\.\d+)?)\s*≈\s*(\d+(?:\.\d+)?)\s*秒\s*$/m);
  if (!meta) errors.push("缺少单行元信息「区间总时长：track_st … → track_ed … ≈ … 秒」");

  const cnStart = firstMatchIndex(md, /^##\s*一、中文稿.*$/m);
  const enStart = firstMatchIndex(md, /^##\s*二、English Storyboard.*$/mi);
  if (cnStart < 0) errors.push("缺少「## 一、中文稿…」区块");
  if (enStart < 0) errors.push("缺少「## 二、English Storyboard…」区块");
  if (cnStart >= 0 && enStart >= 0 && cnStart >= enStart) errors.push("中文稿必须位于 English Storyboard 之前");

  const cn = cnStart >= 0 ? md.slice(cnStart, enStart >= 0 ? enStart : md.length) : "";
  const en = enStart >= 0 ? md.slice(enStart) : "";
  for (const n of ["①", "②", "③", "④", "⑤"]) {
    if (!new RegExp(`^#{1,6}\\s*${n}`, "m").test(cn)) errors.push(`中文稿缺少 ${n} 区块`);
  }
  for (const n of ["①", "②", "③", "④"]) {
    if (!new RegExp(`^#{1,6}\\s*${n}`, "m").test(en)) errors.push(`English Storyboard 缺少 ${n} 区块`);
  }
  if (!/^>\s*禁忌\s*[:：]/m.test(cn)) errors.push("① 视觉基调缺少独立的「> 禁忌：…」行");
  if (!/^>\s*Avoid\s*[:：]/mi.test(en)) errors.push("English ① Style Lock 缺少独立的「> Avoid: …」行");

  const cnCharBlock = cn.match(/^#{1,6}\s*③[^\n]*\n([\s\S]*?)(?=^#{1,6}\s*④)/m)?.[1] ?? "";
  const enCharBlock = en.match(/^#{1,6}\s*③[^\n]*\n([\s\S]*?)(?=^#{1,6}\s*④)/m)?.[1] ?? "";
  const cnChars = [...cnCharBlock.matchAll(/^####\s+(.+?)\s*$/gm)].map((m) => m[1].trim());
  const enChars = [...enCharBlock.matchAll(/^####\s+(.+?)\s*$/gm)].map((m) => m[1].trim());
  if (cnChars.length === 0) errors.push("③ 角色描述中没有「#### 角色名（备注）」标题");
  if (enChars.length === 0) errors.push("English ③ Characters 中没有角色四级标题");

  const cnShotRe = /^####\s*分镜\s*(\d+)\s*[·•．.]\s*(.*?)\s*[｜|]\s*建议\s*≈?\s*(\d+(?:\.\d+)?)\s*s\b.*[｜|]\s*角色\s*[:：]\s*([^｜|\n]+)/gim;
  const enShotRe = /^####\s*Shot\s*(\d+)\s*[·•．.]\s*(.*?)\s*[｜|]\s*≈?\s*(\d+(?:\.\d+)?)\s*s\b.*[｜|]\s*cast\s*[:：]\s*([^｜|\n]+)/gim;
  const cnShots = [...cn.matchAll(cnShotRe)].map((m) => Number(m[1]));
  const enShots = [...en.matchAll(enShotRe)].map((m) => Number(m[1]));
  if (cnShots.length === 0) errors.push("④ 中没有可解析的「#### 分镜 01 · … ｜建议 ≈Xs … ｜角色：…」标题");
  if (enShots.length === 0) errors.push("English ④ 中没有可解析的「#### Shot 01 · … ｜≈Xs … ｜cast: …」标题");
  if (cnShots.length > 0 && enShots.length > 0 && JSON.stringify(cnShots) !== JSON.stringify(enShots)) {
    errors.push(`中英文镜头序号不一致：CN=${cnShots.join(",")}，EN=${enShots.join(",")}`);
  }

  const cnShotBlock = cn.match(/^#{1,6}\s*④[^\n]*\n([\s\S]*?)(?=^#{1,6}\s*⑤)/m)?.[1] ?? "";
  const enShotBlock = en.match(/^#{1,6}\s*④[^\n]*\n([\s\S]*)/m)?.[1] ?? "";
  const cnHeads = [...cnShotBlock.matchAll(/^####\s+(.+?)\s*$/gm)];
  const enHeads = [...enShotBlock.matchAll(/^####\s+(.+?)\s*$/gm)];
  const extraCnHeads = cnHeads.filter((m) => !/^分镜\s*\d+/i.test(m[1]));
  const extraEnHeads = enHeads.filter((m) => !/^Shot\s*\d+/i.test(m[1]));
  if (extraCnHeads.length > 0) errors.push(`④ 内存在非分镜四级标题：${extraCnHeads.map((m) => m[1]).join("、")}；请把蒙太奇名放进「段」字段`);
  if (extraEnHeads.length > 0) errors.push(`English ④ 内存在非 Shot 四级标题：${extraEnHeads.map((m) => m[1]).join("、")}；请把 montage 名放进 segment 字段`);

  function checkPrefixes(block, heads, label) {
    for (let i = 0; i < heads.length; i += 1) {
      const start = (heads[i].index ?? 0) + heads[i][0].length;
      const end = i + 1 < heads.length ? heads[i + 1].index : block.length;
      const firstBodyLine = block.slice(start, end).split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
      if (!firstBodyLine.startsWith("〔") || !firstBodyLine.includes("〕")) {
        errors.push(`${label} ${heads[i][1].match(/\d+/)?.[0] ?? "?"} 的首个正文不是「〔视觉基调〕」前缀`);
      }
    }
  }
  checkPrefixes(cnShotBlock, cnHeads.filter((m) => /^分镜\s*\d+/i.test(m[1])), "中文分镜");
  checkPrefixes(enShotBlock, enHeads.filter((m) => /^Shot\s*\d+/i.test(m[1])), "English Shot");

  if (/^\s*[-*]\s*(男性|女性|男主|女主|父亲|母亲|角色)\s*[:：]/m.test(cnCharBlock)) {
    errors.push("③ 角色仍使用项目符号；请改成四级标题并把描述另起段落");
  }
  if (/^\s*\*\*(镜头|分镜|Shot)\s*\d+/mi.test(md)) {
    errors.push("镜头仍使用粗体行；请改成「#### 分镜…」/「#### Shot…」四级标题");
  }

  if (meta) {
    const st = Number(meta[1]);
    const ed = Number(meta[2]);
    const total = Number(meta[3]);
    if (!(ed > st)) errors.push("track_ed 必须大于 track_st");
    if (Math.abs((ed - st) - total) > 0.11) errors.push(`区间总时长与 track_ed-track_st 不一致：${total} vs ${(ed - st).toFixed(3)}`);
  }

  return {
    ok: errors.length === 0,
    file: basename(file),
    beatId: beat || null,
    characters: cnChars.length,
    shots: cnShots.length,
    errors,
  };
}

let failed = false;
for (const file of files) {
  try {
    const md = await readFile(file, "utf8");
    const result = validate(md, file);
    console.log(JSON.stringify(result));
    failed ||= !result.ok;
  } catch (error) {
    failed = true;
    console.log(JSON.stringify({ ok: false, file: basename(file), errors: [String(error?.message ?? error)] }));
  }
}

process.exit(failed ? 1 : 0);
