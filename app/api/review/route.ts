import { NextResponse } from "next/server";
import { ZodError } from "zod";
import {
  readReviewWorkspace,
  upsertHumanReview,
} from "../../../lib/review/store";

export const dynamic = "force-dynamic";
const REVIEW_OVERRIDE_DISPLAY_PATH =
  "data/production-shaped-1k.human-review-overrides.json";

function isSameOriginLoopback(request: Request): boolean {
  const requestUrl = new URL(request.url);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(requestUrl.hostname)) {
    return false;
  }
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === requestUrl.host;
  } catch {
    return false;
  }
}

function responseBody(
  workspace: Awaited<ReturnType<typeof readReviewWorkspace>>,
  writable: boolean,
) {
  return {
    worksheet: workspace.worksheet,
    reviews: workspace.overrides.reviews,
    reviewedCount: workspace.overrides.reviews.length,
    totalCount: workspace.worksheet.items.length,
    writable,
    overridePath: REVIEW_OVERRIDE_DISPLAY_PATH,
  };
}

function reviewWritesAllowed(
  request: Request,
  workspace: Awaited<ReturnType<typeof readReviewWorkspace>>,
): boolean {
  const complete =
    workspace.overrides.reviews.length === workspace.worksheet.items.length;
  return (
    process.env.NODE_ENV !== "production" &&
    isSameOriginLoopback(request) &&
    (!complete || process.env.ALLOW_REVIEW_RELABEL === "true")
  );
}

export async function GET(request: Request) {
  try {
    const workspace = await readReviewWorkspace();
    return NextResponse.json(
      responseBody(
        workspace,
        reviewWritesAllowed(request, workspace),
      ),
      {
        headers: { "Cache-Control": "no-store" },
      },
    );
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unable to load the review workspace.",
      },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  if (process.env.NODE_ENV === "production" || !isSameOriginLoopback(request)) {
    return NextResponse.json(
      {
        error:
          "Review writes require local development mode at http://localhost:3000.",
      },
      { status: 403 },
    );
  }

  try {
    const body: unknown = await request.json();
    const submittedReview =
      body && typeof body === "object" && "review" in body
        ? (body as { review: unknown }).review
        : body;
    const workspaceBeforeWrite = await readReviewWorkspace();
    if (!reviewWritesAllowed(request, workspaceBeforeWrite)) {
      return NextResponse.json(
        {
          error:
            "This completed review set is read-only. Set ALLOW_REVIEW_RELABEL=true only for an intentional relabeling session.",
        },
        { status: 409 },
      );
    }
    const review =
      submittedReview && typeof submittedReview === "object"
        ? { ...submittedReview, reviewed_at: new Date().toISOString() }
        : submittedReview;
    const workspace = await upsertHumanReview(review);
    return NextResponse.json(
      responseBody(workspace, reviewWritesAllowed(request, workspace)),
      {
        headers: { "Cache-Control": "no-store" },
      },
    );
  } catch (error) {
    const message =
      error instanceof ZodError
        ? error.issues.map((issue) => issue.message).join("; ")
        : error instanceof Error
          ? error.message
          : "Unable to save the review.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
