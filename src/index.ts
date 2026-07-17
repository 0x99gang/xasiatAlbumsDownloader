import axios from "axios";
import * as cheerio from "cheerio";
import * as fs from "fs";
import * as path from "path";
import { createWriteStream } from "fs";
import { Readable } from "stream";
import pc from "picocolors";
import ora from "ora";
import cliProgress from "cli-progress";

const BASE_URL = "https://www.xasiat.com";
const ALBUM_BLOCK_ID = "list_albums_albums_list_search_result";
const VIDEO_BLOCK_ID = "list_videos_videos_list_search_result";

const axiosInstance = axios.create({
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Referer: BASE_URL,
  },
  timeout: 30000,
});

function sanitizeFilename(name: string): string {
  return name.replace(/[<>:"/\\|?*]/g, "_").trim().substring(0, 200);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Album helpers ──────────────────────────────────────────

function extractAlbumLinks(html: string): string[] {
  const re = /href="(https:\/\/www\.xasiat\.com\/albums\/\d+\/[^"]*)"/g;
  const urls: string[] = [];
  let match;
  while ((match = re.exec(html)) !== null) {
    urls.push(match[1]);
  }
  return [...new Set(urls)];
}

function extractAlbumNames(html: string): string[] {
  const $ = cheerio.load(html);
  const names: string[] = [];
  $("#list_albums_albums_list_search_result_items .item a[href*='/albums/'] strong.title").each((_, el) => {
    names.push($(el).text().trim());
  });
  return names;
}

async function fetchAlbumSearchPage(keyword: string, page: number): Promise<string> {
  const encoded = encodeURIComponent(keyword);
  if (page === 1) {
    const resp = await axiosInstance.get(`${BASE_URL}/search/${encoded}/`);
    return resp.data;
  }
  const params = new URLSearchParams();
  params.append("mode", "async");
  params.append("function", "get_block");
  params.append("block_id", ALBUM_BLOCK_ID);
  params.append("q", keyword);
  params.append("category_ids", "");
  params.append("sort_by", "");
  params.append("from_videos", String(page));
  params.append("from_albums", String(page));
  const resp = await axiosInstance.get(`${BASE_URL}/search/${encoded}/?${params.toString()}`, {
    headers: { "X-Requested-With": "XMLHttpRequest" },
  });
  return resp.data;
}

async function fetchAlbumUrls(keyword: string): Promise<{ url: string; name: string }[]> {
  const results: { url: string; name: string }[] = [];
  let page = 1;
  const spinner = ora({ text: `Searching albums (page ${page})...`, color: "cyan" }).start();

  while (true) {
    const html = await fetchAlbumSearchPage(keyword, page);
    const urls = extractAlbumLinks(html);
    if (urls.length === 0) break;

    if (page > 1) {
      const names = extractAlbumNames(html);
      const keywordInNames = names.some((n) => n.includes(keyword));
      if (!keywordInNames) break;
    }

    const $ = cheerio.load(html);
    $("#list_albums_albums_list_search_result_items .item a[href*='/albums/']").each((_, el) => {
      const href = $(el).attr("href");
      const name = $(el).find("strong.title").text().trim();
      if (href && name) results.push({ url: href, name });
    });

    page++;
    if (results.length > 0) {
      spinner.text = `Searching albums (page ${page}, ${results.length} found)...`;
    }
  }

  spinner.succeed(pc.green(`Found ${results.length} albums`));
  return results;
}

async function fetchAlbumImages(albumUrl: string): Promise<{ imageUrls: string[]; albumName: string }> {
  const spinner = ora("Fetching album info...").start();
  const resp = await axiosInstance.get(albumUrl);
  const $ = cheerio.load(resp.data);
  const albumName = $("h1").first().text().trim() || `album_${albumUrl.split("/").filter(Boolean).pop() || "unknown"}`;
  const imageUrls: string[] = [];
  $('.album-holder .images a.item[rel="images"]').each((_, el) => {
    const href = $(el).attr("href");
    if (href) imageUrls.push(href);
  });
  spinner.succeed(`${pc.cyan(albumName)} ${pc.dim(`(${imageUrls.length} images)`)}`);
  return { imageUrls, albumName };
}

async function downloadImage(url: string, filePath: string): Promise<void> {
  const resp = await axiosInstance.get(url, { responseType: "arraybuffer" });
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, resp.data);
}

async function downloadAlbum(albumUrl: string, keyword: string, outputDir: string, delayMs: number): Promise<void> {
  const { imageUrls, albumName } = await fetchAlbumImages(albumUrl);
  if (imageUrls.length === 0) {
    console.log(`  ${pc.yellow("No images found.")}`);
    return;
  }

  if (!albumName.includes(keyword)) {
    console.log(`  ${pc.dim(`Skipped (name doesn't match keyword): ${albumName}`)}`);
    return;
  }

  const folderName = sanitizeFilename(albumName);
  const albumDir = path.join(outputDir, folderName);

  const progress = new cliProgress.SingleBar({
    format: `  ${pc.cyan("{bar}")} {percentage}% | {value}/{total} | {status}`,
    barCompleteChar: "█",
    barIncompleteChar: "░",
    hideCursor: true,
  });
  progress.start(imageUrls.length, 0, { status: "starting..." });

  for (let i = 0; i < imageUrls.length; i++) {
    const url = imageUrls[i];
    const ext = path.extname(new URL(url).pathname) || ".jpg";
    const fileName = `${String(i + 1).padStart(3, "0")}${ext}`;
    const filePath = path.join(albumDir, fileName);

    if (fs.existsSync(filePath)) {
      progress.update(i + 1, { status: pc.dim("exists") });
      continue;
    }

    try {
      await downloadImage(url, filePath);
      progress.update(i + 1, { status: pc.green("ok") });
      await sleep(delayMs);
    } catch (err) {
      progress.update(i + 1, { status: pc.red("fail") });
    }
  }

  progress.stop();
}

// ── Video helpers ──────────────────────────────────────────

async function fetchVideoSearchPage(keyword: string, page: number): Promise<string> {
  const encoded = encodeURIComponent(keyword);
  if (page === 1) {
    const resp = await axiosInstance.get(`${BASE_URL}/search/${encoded}/`);
    return resp.data;
  }
  const params = new URLSearchParams();
  params.append("mode", "async");
  params.append("function", "get_block");
  params.append("block_id", VIDEO_BLOCK_ID);
  params.append("q", keyword);
  params.append("category_ids", "");
  params.append("sort_by", "");
  params.append("from_videos", String(page));
  params.append("from_albums", String(page));
  const resp = await axiosInstance.get(`${BASE_URL}/search/${encoded}/?${params.toString()}`, {
    headers: { "X-Requested-With": "XMLHttpRequest" },
  });
  return resp.data;
}

async function fetchVideoUrls(keyword: string): Promise<{ url: string; title: string }[]> {
  const results: { url: string; title: string }[] = [];
  let page = 1;
  const spinner = ora({ text: `Searching videos (page ${page})...`, color: "magenta" }).start();

  while (true) {
    const html = await fetchVideoSearchPage(keyword, page);

    const $ = cheerio.load(html);
    let found = false;
    $("#list_videos_videos_list_search_result_items .item a[href*='/videos/']").each((_, el) => {
      const href = $(el).attr("href");
      const title = $(el).find("strong.title").text().trim();
      if (href && title) {
        results.push({ url: href, title });
        found = true;
      }
    });

    if (!found) break;

    if (page > 1) {
      const keywordInNames = results.slice(-10).some((r) => r.title.includes(keyword));
      if (!keywordInNames) break;
    }

    page++;
    if (results.length > 0) {
      spinner.text = `Searching videos (page ${page}, ${results.length} found)...`;
    }
  }

  spinner.succeed(pc.magenta(`Found ${results.length} videos`));
  return results;
}

async function fetchVideoUrl(videoPageUrl: string): Promise<string | null> {
  const spinner = ora("Fetching video source...").start();
  const resp = await axiosInstance.get(videoPageUrl);
  const $ = cheerio.load(resp.data);

  const jsonldScript = $('script[type="application/ld+json"]').text().trim();
  if (jsonldScript) {
    try {
      const parsed = JSON.parse(jsonldScript);
      const data = Array.isArray(parsed) ? parsed[0] : parsed;
      if (data && data.contentUrl) {
        spinner.succeed(pc.green("Video source found"));
        return data.contentUrl;
      }
    } catch {}
  }

  const flashvars = $('param[name="flashvars"]').attr("value");
  if (flashvars) {
    const altMatch = flashvars.match(/[?&]alt=([^&]+)/);
    if (altMatch) {
      spinner.succeed(pc.green("Video source found (alt)"));
      return decodeURIComponent(altMatch[1]);
    }
    const videoUrlMatch = flashvars.match(/[?&]video_url=([^&]+)/);
    if (videoUrlMatch) {
      spinner.succeed(pc.green("Video source found"));
      return decodeURIComponent(videoUrlMatch[1]);
    }
  }

  const scripts = $("script").toArray();
  for (const script of scripts) {
    const text = $(script).text();
    const m = text.match(/["'](https?:\/\/[^"']+\.mp4)["']/);
    if (m) {
      spinner.succeed(pc.green("Video source found (script)"));
      return m[1];
    }
  }

  spinner.fail(pc.red("No video source found"));
  return null;
}

async function downloadVideoFile(videoUrl: string, filePath: string): Promise<void> {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const writer = createWriteStream(filePath);
  const resp = await axiosInstance.get(videoUrl, { responseType: "stream" });
  (resp.data as Readable).pipe(writer);
  return new Promise((resolve, reject) => {
    writer.on("finish", resolve);
    writer.on("error", reject);
  });
}

async function downloadSingleVideo(videoUrl: string, keyword: string, outputDir: string, delayMs: number): Promise<void> {
  const srcUrl = await fetchVideoUrl(videoUrl);
  if (!srcUrl) return;

  const spinner = ora("Fetching video title...").start();
  const $ = cheerio.load((await axiosInstance.get(videoUrl)).data);
  const title = $("h1").first().text().trim() || `video_${videoUrl.split("/").filter(Boolean).pop() || "unknown"}`;
  spinner.text = `Downloading: ${title}`;

  const fileName = sanitizeFilename(title) + ".mp4";
  const filePath = path.join(outputDir, fileName);

  if (fs.existsSync(filePath)) {
    spinner.info(pc.dim(`Already exists: ${title}`));
    return;
  }

  try {
    spinner.color = "yellow";
    spinner.text = `Downloading ${fileName}...`;
    await downloadVideoFile(srcUrl, filePath);
    spinner.succeed(pc.green(`Downloaded: ${fileName}`));
    await sleep(delayMs);
  } catch (err) {
    spinner.fail(pc.red(`Failed: ${(err as Error).message}`));
  }
}

// ── Display helpers ────────────────────────────────────────

function printTable(items: { title: string; url: string }[], type: string): void {
  if (items.length === 0) {
    console.log(`  ${pc.yellow(`No ${type} found.`)}`);
    return;
  }
  const cols = 72;
  const sep = pc.dim(`  ${"".padEnd(cols, "-")}`);
  console.log(sep);
  for (let i = 0; i < items.length; i++) {
    const num = pc.cyan(`${i + 1}.`);
    const title = items[i].title.length > cols - 8 ? items[i].title.substring(0, cols - 11) + "..." : items[i].title;
    console.log(`  ${num.padEnd(4)} ${pc.white(title)}`);
    const url = items[i].url.length > cols - 6 ? items[i].url.substring(0, cols - 9) + "..." : items[i].url;
    console.log(`       ${pc.dim(url)}`);
    console.log(sep);
  }
}

// ── Commands ───────────────────────────────────────────────

async function cmdSearch(keyword: string): Promise<void> {
  console.log(`\n  ${pc.bold(pc.cyan("xasiat-downloader"))} ${pc.dim("— search results")}\n`);

  const [albums, videos] = await Promise.all([
    fetchAlbumUrls(keyword).catch(() => [] as { url: string; name: string }[]),
    fetchVideoUrls(keyword).catch(() => [] as { url: string; title: string }[]),
  ]);

  console.log(`\n  ${pc.bold(pc.blue(`Albums (${albums.length})`))}`);
  printTable(albums.map((a) => ({ title: a.name, url: a.url })), "albums");

  console.log(`\n  ${pc.bold(pc.magenta(`Videos (${videos.length})`))}`);
  printTable(videos.map((v) => ({ title: v.title, url: v.url })), "videos");

  console.log(`\n  ${pc.dim("Usage:")} ${pc.cyan("xasiat-downloader download <url>")}\n`);
}

async function cmdDownload(url: string, delayMs: number): Promise<void> {
  const outputDir = path.resolve(process.cwd(), "downloads", "single");

  if (url.includes("/albums/")) {
    const keyword = url.split("/").pop() || "";
    await downloadAlbum(url, keyword, outputDir, delayMs);
  } else if (url.includes("/videos/")) {
    await downloadSingleVideo(url, "", outputDir, delayMs);
  } else {
    console.error(pc.red(`Unknown URL type: ${url}`));
    process.exit(1);
  }
}

async function cmdKeyword(
  keyword: string,
  opts: { delay: number; limit: number; output: string; videos: boolean; all: boolean }
): Promise<void> {
  const baseDir = path.resolve(process.cwd(), opts.output);
  const outputDir = path.join(baseDir, sanitizeFilename(keyword));
  fs.mkdirSync(outputDir, { recursive: true });

  if (opts.all || !opts.videos) {
    console.log(`\n  ${pc.bold(pc.blue("Albums"))}\n`);
    const albums = await fetchAlbumUrls(keyword);
    const albumList = opts.limit < albums.length ? albums.slice(0, opts.limit) : albums;
    console.log(`  Downloading ${pc.cyan(String(albumList.length))} of ${pc.cyan(String(albums.length))} albums\n`);

    for (let i = 0; i < albumList.length; i++) {
      console.log(`  ${pc.dim(`[${i + 1}/${albumList.length}]`)} ${albumList[i].name}`);
      try {
        await downloadAlbum(albumList[i].url, keyword, opts.all ? path.join(outputDir, "albums") : outputDir, opts.delay);
      } catch (err) {
        console.error(`  ${pc.red(`Failed: ${(err as Error).message}`)}`);
      }
    }
  }

  if (opts.all || opts.videos) {
    console.log(`\n  ${pc.bold(pc.magenta("Videos"))}\n`);
    const videos = await fetchVideoUrls(keyword);
    const videoList = opts.limit < videos.length ? videos.slice(0, opts.limit) : videos;
    console.log(`  Downloading ${pc.cyan(String(videoList.length))} of ${pc.cyan(String(videos.length))} videos\n`);

    for (let i = 0; i < videoList.length; i++) {
      console.log(`  ${pc.dim(`[${i + 1}/${videoList.length}]`)} ${videoList[i].title}`);
      try {
        await downloadSingleVideo(videoList[i].url, keyword, opts.all ? path.join(outputDir, "videos") : outputDir, opts.delay);
      } catch (err) {
        console.error(`  ${pc.red(`Failed: ${(err as Error).message}`)}`);
      }
    }
  }
}

// ── CLI ────────────────────────────────────────────────────

type Command = "search" | "download" | "keyword";

interface Options {
  command: Command;
  keyword: string;
  url: string;
  delay: number;
  limit: number;
  output: string;
  videos: boolean;
  all: boolean;
  help: boolean;
}

function parseArgs(): Options {
  const args = process.argv.slice(2);
  const opts: Options = {
    command: "keyword",
    keyword: "",
    url: "",
    delay: 2000,
    limit: Infinity,
    output: "downloads",
    videos: false,
    all: false,
    help: false,
  };

  let i = 0;
  function advance(): string | undefined {
    return args[i++];
  }

  while (i < args.length) {
    const arg = advance()!;

    switch (arg) {
      case "--help":
      case "-h":
        opts.help = true;
        break;
      case "--delay":
        opts.delay = parseInt(advance() || "2000", 10) || 2000;
        break;
      case "--limit":
        opts.limit = parseInt(advance() || "", 10) || Infinity;
        break;
      case "--output":
        opts.output = advance() || "downloads";
        break;
      case "--videos":
        opts.videos = true;
        break;
      case "--all":
        opts.all = true;
        break;
      default:
        if (arg === "search" && !opts.keyword && !opts.url) {
          opts.command = "search";
        } else if (arg === "download" && !opts.keyword && !opts.url) {
          opts.command = "download";
          opts.url = advance() || "";
        } else if (!opts.keyword) {
          opts.keyword = arg;
        }
    }
  }

  return opts;
}

function showHelp(): void {
  console.log(`
  ${pc.bold(pc.cyan("xasiat-downloader"))} ${pc.dim("— Download albums & videos from xasiat.com")}

  ${pc.bold("USAGE")}
    ${pc.cyan("xasiat-downloader <keyword> [options]")}     ${pc.dim("Download albums for keyword")}
    ${pc.cyan("xasiat-downloader <keyword> --videos")}      ${pc.dim("Download videos for keyword")}
    ${pc.cyan("xasiat-downloader <keyword> --all")}         ${pc.dim("Download albums + videos")}
    ${pc.cyan("xasiat-downloader search <keyword>")}        ${pc.dim("List albums & videos")}
    ${pc.cyan("xasiat-downloader download <url>")}          ${pc.dim("Download single album/video")}

  ${pc.bold("ARGUMENTS")}
    keyword                  ${pc.dim("Search keyword")}

  ${pc.bold("OPTIONS")}
    --delay <ms>             ${pc.dim("Delay between downloads")} ${pc.green("(default: 2000)")}
    --limit <count>          ${pc.dim("Max items to download")} ${pc.green("(default: all)")}
    --output <dir>           ${pc.dim("Output directory")} ${pc.green("(default: ./downloads)")}
    --videos                 ${pc.dim("Download videos instead of albums")}
    --all                    ${pc.dim("Download both albums and videos")}
    --help, -h               ${pc.dim("Show this help message")}

  ${pc.bold("EXAMPLES")}
    ${pc.cyan("xasiat-downloader 石川澪")}
    ${pc.cyan("xasiat-downloader 石川澪 --videos")}
    ${pc.cyan("xasiat-downloader 石川澪 --all --limit 3")}
    ${pc.cyan("xasiat-downloader search 石川澪")}
    ${pc.cyan("xasiat-downloader download <url>")}
`);
}

async function main() {
  const opts = parseArgs();

  if (opts.help || (opts.command === "keyword" && !opts.keyword) || (opts.command === "download" && !opts.url) || (opts.command === "search" && !opts.keyword)) {
    showHelp();
    process.exit(opts.help ? 0 : 1);
  }

  switch (opts.command) {
    case "search":
      await cmdSearch(opts.keyword);
      break;
    case "download":
      await cmdDownload(opts.url, opts.delay);
      break;
    case "keyword":
      await cmdKeyword(opts.keyword, opts);
      break;
  }
}

main().catch(console.error);
