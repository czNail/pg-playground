export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string) {
  const node = document.createElement(tag); node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
export function action(text: string, handler: () => void, className = '') {
  const node = el('button', className, text); node.type = 'button'; node.addEventListener('click', handler); return node;
}
export function downloadFile(data: BlobPart, name: string, type = 'application/octet-stream') {
  const url = URL.createObjectURL(new Blob([data], {type}));
  const link = el('a'); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export async function copyText(text: string, toast: (message: string) => void) {
  try { await navigator.clipboard.writeText(text); toast('已复制。'); }
  catch { toast('复制未成功，请在详情中选择文字复制。'); }
}
