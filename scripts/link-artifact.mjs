export function linkArtifact(artifact, addresses) {
  let bytecode = artifact.bytecode.slice(2);
  for (const sourceReferences of Object.values(artifact.linkReferences ?? {})) {
    for (const [library, references] of Object.entries(sourceReferences)) {
      const address = addresses[library]?.replace(/^0x/, "").toLowerCase();
      if (!address || address.length !== 40) throw new Error(`missing library address for ${library}`);
      for (const reference of references) {
        const start = reference.start * 2,
          length = reference.length * 2;
        bytecode = bytecode.slice(0, start) + address.padStart(length, "0") + bytecode.slice(start + length);
      }
    }
  }
  return { ...artifact, bytecode: `0x${bytecode}` };
}
