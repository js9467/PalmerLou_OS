type DepthTempPoint = {
  timestamp: string;
  depthFeet: number | null;
  waterTempF: number | null;
};

type DepthTempGraphProps = {
  points: DepthTempPoint[];
};

function buildLinePath(
  points: DepthTempPoint[],
  width: number,
  height: number,
  accessor: (point: DepthTempPoint) => number | null,
  domainMin: number,
  domainMax: number,
  padLeft: number,
  padRight: number,
  padTop: number,
  padBottom: number
) {
  const drawWidth = width - padLeft - padRight;
  const drawHeight = height - padTop - padBottom;
  const spread = Math.max(domainMax - domainMin, 0.0001);
  let path = "";
  let penDown = false;

  points.forEach((point, index) => {
    const value = accessor(point);
    if (value === null) {
      penDown = false;
      return;
    }

    const x = padLeft + (index / Math.max(points.length - 1, 1)) * drawWidth;
    const y = padTop + (1 - (value - domainMin) / spread) * drawHeight;

    if (!penDown) {
      path += `M ${x.toFixed(2)} ${y.toFixed(2)} `;
      penDown = true;
    } else {
      path += `L ${x.toFixed(2)} ${y.toFixed(2)} `;
    }
  });

  return path.trim();
}

function computeDomain(values: number[]) {
  if (values.length === 0) {
    return { min: 0, max: 1 };
  }

  const min = Math.min(...values);
  const max = Math.max(...values);

  if (min === max) {
    return { min: min - 1, max: max + 1 };
  }

  const pad = (max - min) * 0.12;
  return { min: min - pad, max: max + pad };
}

export function DepthTempGraph({ points }: DepthTempGraphProps) {
  const width = 980;
  const height = 210;
  const padLeft = 16;
  const padRight = 16;
  const padTop = 12;
  const padBottom = 24;

  const depthValues = points.map((point) => point.depthFeet).filter((value): value is number => value !== null);
  const tempValues = points.map((point) => point.waterTempF).filter((value): value is number => value !== null);

  const depthDomain = computeDomain(depthValues);
  const tempDomain = computeDomain(tempValues);

  const depthPath = buildLinePath(
    points,
    width,
    height,
    (point) => point.depthFeet,
    depthDomain.min,
    depthDomain.max,
    padLeft,
    padRight,
    padTop,
    padBottom
  );

  const tempPath = buildLinePath(
    points,
    width,
    height,
    (point) => point.waterTempF,
    tempDomain.min,
    tempDomain.max,
    padLeft,
    padRight,
    padTop,
    padBottom
  );

  const firstPoint = points[0] ?? null;
  const lastPoint = points[points.length - 1] ?? null;
  const startTime = firstPoint ? new Date(firstPoint.timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "--";
  const endTime = lastPoint ? new Date(lastPoint.timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "--";

  return (
    <div className="depth-temp-graph" role="img" aria-label="Depth and water temperature trend graph">
      <svg className="depth-temp-graph__svg" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
        <g className="depth-temp-graph__grid">
          <line x1={padLeft} y1={height - padBottom} x2={width - padRight} y2={height - padBottom} />
          <line x1={padLeft} y1={height * 0.65} x2={width - padRight} y2={height * 0.65} />
          <line x1={padLeft} y1={height * 0.4} x2={width - padRight} y2={height * 0.4} />
          <line x1={padLeft} y1={padTop} x2={width - padRight} y2={padTop} />
        </g>

        {depthPath ? <path className="depth-temp-graph__line depth-temp-graph__line--depth" d={depthPath} /> : null}
        {tempPath ? <path className="depth-temp-graph__line depth-temp-graph__line--temp" d={tempPath} /> : null}
      </svg>

      <div className="depth-temp-graph__axis">
        <span>{startTime}</span>
        <span>{endTime}</span>
      </div>
    </div>
  );
}
