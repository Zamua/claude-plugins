// Reads every session's state file under the projects folder, as `<project>/<session>`.

import { readTextFile, home } from "herdr";
import { readdir } from "fs/promises";

export const folderOf = (p) => {
  const f = p?.folder ?? "~/projects";
  return f.startsWith("~") ? home() + f.slice(1) : f;
};

export async function readFiles(folder) {
  const files = new Map();
  let dirs = [];
  try {
    dirs = await readdir(folder, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const d of dirs) {
    if (!d.isDirectory() || /^[._]/.test(d.name) || d.name === "bin") continue;
    let names = [];
    try {
      names = await readdir(`${folder}/${d.name}`);
    } catch {
      continue;
    }
    for (const n of names.filter((n) => n.endsWith(".json"))) {
      try {
        const text = await readTextFile(`${folder}/${d.name}/${n}`);
        if (text) files.set(`${d.name}/${n.slice(0, -5)}`, JSON.parse(text));
      } catch {
        // A file caught mid-write is read again on its next change
      }
    }
  }
  return files;
}
