# xasiat-albums-downloader

Download photo albums from xasiat.com by keyword.

## Build

```sh
bun install
bun run build
```

Output: `xasiat-downloader.exe`

## Usage

```sh
xasiat-downloader <keyword> [options]
```

### Examples

```sh
xasiat-downloader 石川澪
xasiat-downloader "石川澪" --limit 3
xasiat-downloader 石川澪 --delay 1000 --output ./photos
xasiat-downloader --help
```

### Options

| Flag | Description |
|------|-------------|
| `--delay <ms>` | Delay between image downloads (default: 2000) |
| `--limit <count>` | Max albums to download (default: all) |
| `--output <dir>` | Output directory (default: ./downloads) |
| `--help, -h` | Show help |

### Output structure

```
downloads/<keyword>/<album-name>/001.jpg
```
