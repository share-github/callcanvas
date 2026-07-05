import { buildApiSummary } from "../../../lib/apiSummary";

export function GET() {
  return buildApiSummary("Reader");
}
