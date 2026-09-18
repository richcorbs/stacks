import { describe, expect, it } from 'vitest';
import { GENERATE_PR_METADATA_PROMPT } from './pullRequestMetadata';

describe('pull request metadata prompt', () => {
  it('preserves the exact output and repository-safety contract', () => {
    expect(GENERATE_PR_METADATA_PROMPT).toBe('Generate succinct pull request metadata from the completed diff and commits. Write exactly one JSON object with string fields "title" and "body" to $(git rev-parse --git-dir)/stacks-pr-metadata.json. Do not alter the worktree or commits.');
  });
});
