const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

export function drawHandOverlay(canvas, hands = [], { width, height } = {}) {
  const context = canvas?.getContext?.('2d');
  if (!context) return false;

  const frameWidth = Math.max(1, Math.round(width || canvas.width || canvas.clientWidth || 1));
  const frameHeight = Math.max(1, Math.round(height || canvas.height || canvas.clientHeight || 1));
  if (canvas.width !== frameWidth) canvas.width = frameWidth;
  if (canvas.height !== frameHeight) canvas.height = frameHeight;
  context.clearRect(0, 0, frameWidth, frameHeight);

  if (!Array.isArray(hands)) return false;
  let drawn = false;
  for (const landmarks of hands) {
    if (!Array.isArray(landmarks) || landmarks.length < 21) continue;
    const points = landmarks.slice(0, 21);
    if (points.some((point) => !Number.isFinite(point?.x) || !Number.isFinite(point?.y))) continue;

    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.lineWidth = Math.max(2, frameWidth / 320);
    context.strokeStyle = '#a5f3c8';
    for (const [from, to] of HAND_CONNECTIONS) {
      context.beginPath();
      context.moveTo(points[from].x * frameWidth, points[from].y * frameHeight);
      context.lineTo(points[to].x * frameWidth, points[to].y * frameHeight);
      context.stroke();
    }

    context.fillStyle = '#baf7d6';
    context.strokeStyle = '#173b2c';
    context.lineWidth = Math.max(1, frameWidth / 640);
    const radius = Math.max(3, frameWidth / 160);
    for (const point of points) {
      context.beginPath();
      context.arc(point.x * frameWidth, point.y * frameHeight, radius, 0, Math.PI * 2);
      context.fill();
      context.stroke();
    }
    drawn = true;
  }

  return drawn;
}
