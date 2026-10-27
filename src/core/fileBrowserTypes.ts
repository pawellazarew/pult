export interface FileScope { cwd: string; userHome?: string; allowedFiles?: readonly string[] }
export interface FileEntry { name: string; path: string; kind: 'directory' | 'file'; size: number; modifiedAt: string }
export interface FileListing { root: string; path: string; entries: FileEntry[]; truncated: boolean }
export interface FilePreview {
  path: string; name: string; kind: 'text' | 'markdown' | 'image' | 'pdf' | 'unsupported'; size: number; modifiedAt: string
  text?: string; dataUrl?: string; base64?: string; reason?: string; truncated?: boolean
}
