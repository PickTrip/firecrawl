import { Meta } from "../..";
import { EngineScrapeResult } from "..";
import { specialtyScrapeCheck } from "../utils/specialtyHandler";
import axios, { Axios, AxiosError, type AxiosResponse } from "axios";
import { EngineError, TimeoutError } from "../../error";

const SCRAPER_API_KEY = process.env.SCRAPER_API_KEY!;

export async function scrapeURLWithScraperApi(
  meta: Meta,
  timeToRun: number | undefined,
): Promise<EngineScrapeResult> {
  const timeoutMs = (timeToRun ?? 300000) + meta.options.waitFor;
  let response: AxiosResponse<any>;

  try {
    // Initiate the ScraperAPI request using axios.get
    const axiosPromise = axios.get("https://api.scraperapi.com/", {
      params: {
        api_key: SCRAPER_API_KEY,
        url: meta.url,
        render: true,
        screenshot: meta.options.formats.includes("screenshot"),
      },
      responseType: "arraybuffer",
    });

    // Create a timeout promise
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new TimeoutError("ScraperAPI timed out")),
        timeoutMs,
      ),
    );

    // Race the axios request against the timeout
    response = await Promise.race([axiosPromise, timeoutPromise]);
  } catch (error) {
    if (error instanceof AxiosError && error.response !== undefined) {
      response = error.response;
    } else {
      throw error;
    }
  }

  // Decode the response data (assumed to be a Buffer) into a JSON object.
  let body: {
    [x: string]: any;
    headers: Record<string, string> | undefined;
    errors: any;
    body: { error: any };
    screenshot: any;
  };
  try {
    const data: Buffer = response.data;
    body = JSON.parse(new TextDecoder().decode(data));
  } catch (parseError) {
    meta.logger.error("Failed to parse ScraperAPI response", {
      error: parseError,
    });
    throw new EngineError("Failed to parse ScraperAPI response", {
      cause: parseError,
    });
  }

  const headers = body.headers ?? {};
  const isHiddenEngineError = !(
    headers["Date"] ??
    headers["date"] ??
    headers["Content-Type"] ??
    headers["content-type"]
  );

  // Check for errors in the returned body
  if (body.errors || body.body?.error || isHiddenEngineError) {
    meta.logger.error("ScraperAPI threw an error", {
      errorDetail: body.body?.error ?? body.errors ?? body.body ?? body,
    });
    throw new EngineError("Engine error #34", {
      cause: { body, statusCode: response.status },
    });
  }

  if (typeof body.body !== "string") {
    meta.logger.error("ScraperAPI: Body is not a string", { body });
    throw new EngineError("Engine error #35", {
      cause: { body, statusCode: response.status },
    });
  }

  // Check for any specialty scrape requirements
  await specialtyScrapeCheck(
    meta.logger.child({
      method: "scrapeURLWithScraperApi/specialtyScrapeCheck",
    }),
    body.headers,
  );

  // Return the result object, adding screenshot if available.
  return {
    url: body["resolved-url"] ?? meta.url,
    html: body.body,
    error: response.status >= 300 ? response.statusText : undefined,
    statusCode: response.status,
    ...(body.screenshot
      ? {
          screenshot: `data:image/png;base64,${body.screenshot}`,
        }
      : {}),
  };
}
