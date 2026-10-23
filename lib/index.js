import { createPlugin, pkgRootFrom } from '@deepwhale-cn/dsh-guard-core/plugin';

export const { name, inject, apply } = createPlugin({
  name: 'web-snapshot',
  pkgRoot: pkgRootFrom(import.meta.url),
  skillFile: 'skill/web-snapshot.md',
  binFile: 'bin/cli.mjs',
  description: '把 URL 抓成 Markdown（标题 / 正文 / 日期 / 来源），一次一批',
  whenToUse: '用户提到「网页快照」或任务属于该场景时使用',
});
