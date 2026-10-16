import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { openExternalUrl, webUrl } from './externalLinks';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

describe('external web URLs', () => {
  beforeEach(() => { vi.mocked(invoke).mockReset().mockResolvedValue(undefined); });

  it.each([undefined, null, '', '/docs', '#anchor', '//example.com', 'mailto:a@example.com', 'file:///tmp/a', 'javascript:alert(1)', 'data:text/html,bad', 'https://', 'https://[invalid'])('rejects unsupported or invalid URLs: %s', async (url) => {
    expect(webUrl(url)).toBeUndefined();
    await openExternalUrl(url);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('normalizes scheme casing for the existing native command without rewriting the URL', async () => {
    await openExternalUrl('HTTPS://example.com/path?q=%20#fragment');
    expect(invoke).toHaveBeenCalledExactlyOnceWith('open_url', { url: 'https://example.com/path?q=%20#fragment' });
  });
});
