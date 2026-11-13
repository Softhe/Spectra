// Files on disk -> GroupReport, plus the tool versions that produced it.
import { compareGroup } from "../../src/lib/audio/compare-group.ts";
import { decoderVersion, loadAudioFile } from "./decode.mjs";
import { version } from "./version.mjs";

/**
 * paths: 2-4 file paths. options.displayNames replaces the names shown in the
 * report (uploads); options.includePaths=false omits local paths from it.
 */
export async function compareFiles(paths, options = {}) {
  const { displayNames, includePaths = true, signal, ...rest } = options;
  const inputs = [];
  // Sequential decode keeps peak memory to the files actually held.
  for (let i = 0; i < paths.length; i++) {
    try {
      inputs.push(await loadAudioFile(paths[i], { ...rest, displayName: displayNames?.[i] }));
    } catch (err) {
      const name = displayNames?.[i] ?? paths[i];
      throw new Error(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const report = await compareGroup(inputs, {
    signal,
    checkDecodedEquivalence: rest.checkDecodedEquivalence ?? true,
  });
  if (includePaths) report.files.forEach((f, i) => (f.path = paths[i]));
  return {
    tool: {
      name: "spectra",
      version: version(),
      decoder: await decoderVersion().catch(() => null),
    },
    ...report,
  };
}
