export function formatCurrency(value: number, currency = "USD") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 2
  }).format(value);
}

export function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value);
}

// 带千位分隔的数字格式
export function formatNumberWithCommas(value: number) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

// 简化大数：1000 -> 1k, 1000000 -> 1M, 1000000000 -> 1.00B
export function formatCompactNumber(value: number) {
  if (value >= 1_000_000_000) {
    return (value / 1_000_000_000).toFixed(2) + 'B';
  }
  if (value >= 1_000_000) {
    const scaledTimesTen = Math.floor((value * 10) / 1_000_000);
    const scaled = scaledTimesTen / 10;
    const formatted = Number.isInteger(scaled) ? scaled.toFixed(0) : scaled.toFixed(1);
    return formatted + 'M';
  }
  if (value >= 1_000) {
    const scaledTimesTen = Math.floor((value * 10) / 1_000);
    const scaled = scaledTimesTen / 10;
    const formatted = Number.isInteger(scaled) ? scaled.toFixed(0) : scaled.toFixed(1);
    return formatted + 'k';
  }
  return value.toString();
}

// 格式化小时标签：MM-DD HH -> MM/DD HH:00
export function formatHourLabel(label: string) {
  // 新格式: "12-15 08" -> "12/15 08:00"
  const parts = label.split(' ');
  if (parts.length === 2) {
    const [monthDay, hour] = parts;
    return `${monthDay.replace('-', '/')} ${hour}:00`;
  }
  // 兼容旧格式: "00" -> "00:00"
  return `${label}:00`;
}
