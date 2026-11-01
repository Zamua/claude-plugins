import { expect, test } from 'bun:test'
import { plainText } from './plain-text'

test('MarkdownV2 as an agent writes it reads as plain text: escapes undone, markers dropped', () => {
  const sent = "Great, TestFlight works, so updates now reach you anywhere\\. Passed to ask\\-ios: *tabs* for a project's workers \\(with the sheet\\)\\."
  expect(plainText(sent, 'markdownv2')).toBe("Great, TestFlight works, so updates now reach you anywhere. Passed to ask-ios: tabs for a project's workers (with the sheet).")
})

test('MarkdownV2 links keep their text, code keeps its content, and quotes, spoilers and strikes lose their markers', () => {
  expect(plainText('See [the PR \\#98](https://github.com/x/y/pull/98) for `role` and ||secret|| ~old~ __under__', 'markdownv2'))
    .toBe('See the PR #98 for role and secret old under')
  expect(plainText('>quoted line\nnext', 'markdownv2')).toBe('quoted line\nnext')
  expect(plainText('run:\n```bash\nbun test *.ts\n```\ndone', 'markdownv2')).toBe('run:\nbun test *.ts\ndone')
  expect(plainText('a literal \\* star and \\\\ backslash', 'markdownv2')).toBe('a literal * star and \\ backslash')
})

test('Markdown loses emphasis, code, heading and link markup but keeps words with underscores', () => {
  expect(plainText('## Done\n**Merged** #98: see [PR](https://x) and `snake_case_name` with _care_', 'markdown'))
    .toBe('Done\nMerged #98: see PR and snake_case_name with care')
})

test('plain text is left as it is, trimmed', () => {
  expect(plainText('  *not markup* \\. here  ', 'plain')).toBe('*not markup* \\. here')
})
