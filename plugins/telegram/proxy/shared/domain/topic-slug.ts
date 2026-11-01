// A readable session-name slug from a topic name. tmux names cannot contain '.'
// or ':', so every non-alphanumeric run becomes '-'; 'topic' when nothing survives.
export function topicSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24)
      .replace(/-+$/g, '') || 'topic'
  )
}
