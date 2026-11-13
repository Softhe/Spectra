// Human-readable summary of a compare report (CLI and ?format=text).
function fmtHz(hz) {
  return hz >= 1000 ? `${(hz / 1000).toFixed(1)} kHz` : `${Math.round(hz)} Hz`;
}

export function formatSummary(report) {
  const lines = [];
  for (const f of report.files) {
    const m = f.shared ?? f.base;
    const bits = f.bitDepth ? `${f.bitDepth}-bit` : "";
    const rate = f.containerSampleRate ? `${(f.containerSampleRate / 1000).toFixed(1)} kHz` : "";
    lines.push(
      `${f.label}  ${f.fileName}\n` +
        `   ${[f.codec, bits, rate, `${Math.round(f.averageKbps)} kbps`].filter(Boolean).join(", ")}; ` +
        `${f.durationSec.toFixed(1)} s; sha256 ${f.sha256?.slice(0, 12) ?? "n/a"}\n` +
        `   ${m.qualityClass} class, bandwidth ${fmtHz(m.cutoffHz)}, rolloff ${m.rolloff}, score ${Math.round(m.score)}` +
        `${f.shared ? " (shared passages)" : " (own passages)"}` +
        `${f.unranked ? "; unranked" : f.rank ? `; rank ${f.rank}` : ""}`,
    );
  }
  lines.push("");
  for (const p of report.pairs) {
    const id = p.identity.bytes
      ? "identical bytes"
      : p.identity.decoded
        ? `decoded audio ${p.identity.decoded.status}`
        : "decoded audio not compared";
    lines.push(`${p.a} vs ${p.b}: ${p.headline} [${p.outcome}, evidence ${p.evidence}; ${id}]`);
  }
  const r = report.recommendation;
  lines.push("", `Recommendation: ${r.status}${r.keep ? ` -> keep ${r.keep}` : ""}`, r.summary);
  return lines.join("\n");
}
