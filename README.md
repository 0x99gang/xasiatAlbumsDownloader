# xasiat-downloader

Download photo albums and videos from xasiat.com by keyword.

## Build

```sh
bun install
bun run build
```

Output: `xasiat-downloader.exe`

## Usage

```sh
xasiat-downloader <keyword> [options]
xasiat-downloader search <keyword>
xasiat-downloader download <url>
```

### Examples

```sh
xasiat-downloader 石川澪
xasiat-downloader "Mio Ishikawa" --limit 3
xasiat-downloader 石川澪 --videos
xasiat-downloader 石川澪 --all --delay 1000
xasiat-downloader search 石川澪
xasiat-downloader download https://www.xasiat.com/videos/12345/...
xasiat-downloader --help
```

### Options

| Flag | Description |
|------|-------------|
| `--delay <ms>` | Delay between downloads (default: 2000) |
| `--limit <count>` | Max items to download (default: all) |
| `--output <dir>` | Output directory (default: ./downloads) |
| `--videos` | Download videos instead of albums |
| `--all` | Download both albums and videos |
| `--help, -h` | Show help |

### Output structure

Default (albums):
```
downloads/<keyword>/<album-name>/001.jpg
```

With `--all`:
```
downloads/<keyword>/albums/<album-name>/001.jpg
downloads/<keyword>/videos/<video-title>.mp4
```
