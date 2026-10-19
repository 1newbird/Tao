export interface OutputBlock { id: string; text: string; phase: "pending" | "commentary" | "answer" }

export function updateOutputBlocks(blocks: OutputBlock[], event: { activityId?: string; event: string; text?: string; action?: string }) {
  if (!event.activityId) return blocks;
  const previous = blocks.find((block) => block.id === event.activityId);
  const phase = event.action === "commentary" ? "commentary" : event.action === "answer" ? "answer" : previous?.phase ?? "pending";
  const next: OutputBlock = { id: event.activityId, phase, text: event.event === "text_block_delta" ? (previous?.text ?? "") + (event.text ?? "") : event.text ?? previous?.text ?? "" };
  return previous ? blocks.map((block) => block.id === next.id ? next : block) : [...blocks, next];
}

export function outputAnswer(blocks: OutputBlock[]) {
  let result = "";
  let message = "";
  for (const block of blocks) {
    if (block.phase === "commentary") continue;
    const group = block.id.slice(0, block.id.lastIndexOf(":"));
    if (result && group !== message) result += "\n\n";
    result += block.text;
    message = group;
  }
  return result;
}
