import chokidar, { type FSWatcher } from 'chokidar'
import path from 'node:path'

interface WatcherOptions {
  dir: string
  extensions: string[]
  onChange: (filePath: string) => void
}

export function startWatcher(options: WatcherOptions): FSWatcher {
  const { dir, extensions, onChange } = options

  const extSet = new Set(extensions)

  const watcher = chokidar.watch(dir, {
    ignored: [
      /(^|[/\\])\./,
      '**/node_modules/**',
    ],
    persistent: true,
    ignoreInitial: true,
  })

  let debounceTimer: ReturnType<typeof setTimeout> | null = null

  const handleChange = (filePath: string) => {
    const ext = path.extname(filePath)
    if (!extSet.has(ext)) return

    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      onChange(filePath)
    }, 150)
  }

  watcher.on('change', handleChange)
  watcher.on('add', handleChange)

  return watcher
}
