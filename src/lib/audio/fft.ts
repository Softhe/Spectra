/** In-place radix-2 Cooley–Tukey FFT. Length must be a power of two. */
export function fft(
  real: Float32Array,
  imag: Float32Array,
  inverse = false,
): void {
  const n = real.length;
  if (n !== imag.length || n < 2 || (n & (n - 1)) !== 0) {
    throw new Error("FFT length must be an equal power of two");
  }

  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = real[i]!;
      real[i] = real[j]!;
      real[j] = tr;
      const ti = imag[i]!;
      imag[i] = imag[j]!;
      imag[j] = ti;
    }
  }

  const sign = inverse ? 1 : -1;
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (sign * 2 * Math.PI) / len;
    const wlenRe = Math.cos(ang);
    const wlenIm = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let wRe = 1;
      let wIm = 0;
      for (let j = 0; j < half; j++) {
        const ur = real[i + j]!;
        const ui = imag[i + j]!;
        const vr = real[i + j + half]! * wRe - imag[i + j + half]! * wIm;
        const vi = real[i + j + half]! * wIm + imag[i + j + half]! * wRe;
        real[i + j] = ur + vr;
        imag[i + j] = ui + vi;
        real[i + j + half] = ur - vr;
        imag[i + j + half] = ui - vi;
        const nWRe = wRe * wlenRe - wIm * wlenIm;
        wIm = wRe * wlenIm + wIm * wlenRe;
        wRe = nWRe;
      }
    }
  }

  if (inverse) {
    const inv = 1 / n;
    for (let i = 0; i < n; i++) {
      real[i]! *= inv;
      imag[i]! *= inv;
    }
  }
}

export function hann(n: number): Float32Array {
  const w = new Float32Array(n);
  if (n < 2) {
    w[0] = 1;
    return w;
  }
  for (let i = 0; i < n; i++) {
    w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
  }
  return w;
}
