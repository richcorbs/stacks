import type { ReactTestInstance } from 'react-test-renderer';

/** Read rendered label text without accessibility-hidden sizing or icon content. */
export function renderedText(node: ReactTestInstance | string): string {
  if (typeof node === 'string') return node;
  if (node.props['aria-hidden'] === true || node.props['aria-hidden'] === 'true') return '';
  return node.children.map(renderedText).join('');
}
