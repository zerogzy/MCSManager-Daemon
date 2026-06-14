import axios from "axios";
import * as fs from "fs-extra";
import path from "path";

const DOWNLOAD_TIMEOUT = 120000;
const DOWNLOAD_RETRY_COUNT = 5;
const DOWNLOAD_RETRY_DELAY = 3000;

type DownloadHooks = {
  setTotal(total?: number): void;
  setProgress(downloaded: number, total: number): void;
  logWarn(message: string): void;
};

export async function downloadUpdatePackage(
  url: string,
  targetPath: string,
  expectedSize: number,
  hooks: DownloadHooks
) {
  await fs.ensureDir(path.dirname(targetPath));
  hooks.setTotal(expectedSize || undefined);

  for (let attempt = 1; attempt <= DOWNLOAD_RETRY_COUNT; attempt++) {
    try {
      await downloadOnce(url, targetPath, expectedSize, hooks);
      return;
    } catch (error: any) {
      const downloaded = await getFileSize(targetPath);
      if (attempt >= DOWNLOAD_RETRY_COUNT) throw error;
      hooks.logWarn(`下载中断，将重试 ${attempt}/${DOWNLOAD_RETRY_COUNT - 1}：${error?.message || error}`);
      hooks.setProgress(downloaded, expectedSize || downloaded);
      await sleep(DOWNLOAD_RETRY_DELAY);
    }
  }
}

async function downloadOnce(
  url: string,
  targetPath: string,
  expectedSize: number,
  hooks: DownloadHooks
) {
  const downloadedBefore = await getFileSize(targetPath);
  const headers: Record<string, string> = { "User-Agent": "MCSManager-Update" };
  if (downloadedBefore > 0) headers.Range = `bytes=${downloadedBefore}-`;

  const response = await axios.get(url, {
    responseType: "stream",
    timeout: DOWNLOAD_TIMEOUT,
    headers,
    validateStatus: (status) => status === 200 || status === 206
  });
  const supportRange = response.status === 206;
  if (downloadedBefore > 0 && !supportRange) {
    await fs.remove(targetPath);
  }

  const startSize = supportRange ? downloadedBefore : 0;
  const contentLength = Number(response.headers["content-length"] || 0);
  const total = expectedSize || startSize + contentLength;
  hooks.setTotal(total || undefined);
  let downloaded = startSize;
  const writer = fs.createWriteStream(targetPath, { flags: supportRange ? "a" : "w" });

  response.data.on("data", (chunk: Buffer) => {
    downloaded += chunk.length;
    hooks.setProgress(downloaded, total);
  });
  response.data.pipe(writer);
  await new Promise<void>((resolve, reject) => {
    writer.on("finish", resolve);
    writer.on("error", reject);
    response.data.on("error", reject);
  });
  if (total > 0 && downloaded !== total) throw new Error("更新包下载不完整，请重试");
}

async function getFileSize(filePath: string) {
  try {
    const stat = await fs.stat(filePath);
    return stat.size;
  } catch (_error) {
    return 0;
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
