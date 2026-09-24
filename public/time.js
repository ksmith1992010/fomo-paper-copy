/** America/Chicago wall clock as HH:MM:SS CDT or CST. Empty when the input is not a time. */
export function formatCentral(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (value == null || value === "" || Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const pick = (type) => parts.find((part) => part.type === type)?.value || "";
  let hour = pick("hour");
  if (hour === "24") hour = "00";
  const minute = pick("minute");
  const second = pick("second");
  if (!hour || !minute || !second) return "";
  const wall = Date.UTC(Number(pick("year")), Number(pick("month")) - 1, Number(pick("day")), Number(hour), Number(minute), Number(second));
  const zone = Math.round((wall - date.getTime()) / 36e5) === -5 ? "CDT" : "CST";
  return `${hour}:${minute}:${second} ${zone}`;
}
