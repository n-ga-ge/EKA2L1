// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Browser capability detection for the EKA2L1 web build.
//
// `required` features are ones the emulator cannot start without; `optional`
// ones degrade something (no sound, nothing saved, no gamepad) but still run.
// WebGPU is reported for information only: the emulator renders with WebGL2,
// and nothing here depends on WebGPU being present.

function check(name, ok, detail = '') {
  return { name, ok: Boolean(ok), detail };
}

function webgl2Info() {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    if (!gl) return { ok: false, renderer: '', software: false };

    // Firefox reports the real renderer through RENDERER and warns about the
    // debug extension; other browsers only reveal it through the extension.
    let renderer = String(gl.getParameter(gl.RENDERER) || '');
    if (!renderer || /^webkit webgl$|^webgl/i.test(renderer)) {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      if (ext) renderer = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL));
    }
    const software = /swiftshader|llvmpipe|software|basic render/i.test(renderer);
    const lose = gl.getExtension('WEBGL_lose_context');
    if (lose) lose.loseContext();
    return { ok: true, renderer, software };
  } catch {
    return { ok: false, renderer: '', software: false };
  }
}

// Asks for a WebGPU adapter and device and draws one triangle to an offscreen
// texture, reading a pixel back. Tells a working implementation apart from one
// that merely exposes navigator.gpu.
export async function probeWebGPU() {
  const result = { available: false, working: false, adapter: '', fallback: false, error: '', renderMs: null };
  if (typeof navigator === 'undefined' || !navigator.gpu) {
    result.error = 'navigator.gpu is not exposed';
    return result;
  }

  result.available = true;

  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      result.error = 'no adapter';
      return result;
    }

    const info = adapter.info || {};
    result.adapter = [info.vendor, info.architecture, info.device, info.description].filter(Boolean).join(' ') || 'unnamed adapter';
    result.fallback = Boolean(adapter.isFallbackAdapter || info.isFallbackAdapter);

    const device = await adapter.requestDevice();
    const started = performance.now();

    const size = 16;
    const format = 'rgba8unorm';
    const target = device.createTexture({ size: [size, size], format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    const shader = device.createShaderModule({
      code: `
        @vertex fn vs(@builtin(vertex_index) i : u32) -> @builtin(position) vec4f {
          var p = array<vec2f, 3>(vec2f(-1.0, -3.0), vec2f(-1.0, 1.0), vec2f(3.0, 1.0));
          return vec4f(p[i], 0.0, 1.0);
        }
        @fragment fn fs() -> @location(0) vec4f { return vec4f(0.0, 1.0, 0.0, 1.0); }`,
    });
    const pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: shader, entryPoint: 'vs' },
      fragment: { module: shader, entryPoint: 'fs', targets: [{ format }] },
    });

    const buffer = device.createBuffer({ size: 256 * size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: target.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
    });
    pass.setPipeline(pipeline);
    pass.draw(3);
    pass.end();
    encoder.copyTextureToBuffer({ texture: target }, { buffer, bytesPerRow: 256 }, [size, size]);
    device.queue.submit([encoder.finish()]);

    await buffer.mapAsync(GPUMapMode.READ);
    const pixel = new Uint8Array(buffer.getMappedRange(0, 4)).slice();
    buffer.unmap();

    result.renderMs = Number((performance.now() - started).toFixed(1));
    result.working = pixel[0] === 0 && pixel[1] === 255 && pixel[2] === 0;
    if (!result.working) result.error = `unexpected pixel ${Array.from(pixel).join(',')}`;

    device.destroy();
  } catch (error) {
    result.error = String(error && error.message ? error.message : error);
  }

  return result;
}

export async function detectSupport() {
  const gl = webgl2Info();
  const isolated = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated;

  const required = [
    check('Cross-origin isolation', isolated,
      isolated ? '' : 'the server must send Cross-Origin-Opener-Policy: same-origin and Cross-Origin-Embedder-Policy: require-corp'),
    check('Shared memory (threads)', typeof SharedArrayBuffer !== 'undefined' && typeof Atomics !== 'undefined',
      isolated ? '' : 'needs cross-origin isolation'),
    check('WebAssembly', typeof WebAssembly === 'object' && typeof WebAssembly.instantiateStreaming === 'function'),
    check('WebAssembly exceptions', typeof WebAssembly === 'object' && typeof WebAssembly.Tag === 'function'),
    check('WebGL2', gl.ok, gl.renderer),
    check('OffscreenCanvas', typeof OffscreenCanvas !== 'undefined'
      && typeof HTMLCanvasElement.prototype.transferControlToOffscreen === 'function'),
  ];

  const gpu = await probeWebGPU();

  const optional = [
    check('Audio (AudioWorklet)', typeof AudioWorkletNode !== 'undefined', 'without it the game is silent'),
    check('Persistent storage (OPFS)', Boolean(navigator.storage && navigator.storage.getDirectory), 'without it saves are not kept between visits'),
    check('Gamepad API', typeof navigator.getGamepads === 'function'),
    check('Touch input', navigator.maxTouchPoints > 0, `${navigator.maxTouchPoints || 0} touch points`),
    check('Fullscreen', Boolean(document.fullscreenEnabled || document.webkitFullscreenEnabled)),
    check('Hardware-accelerated WebGL2', gl.ok && !gl.software, gl.software ? 'software renderer: ' + gl.renderer : ''),
    check('WebGPU (not used for rendering)', gpu.working,
      gpu.working ? `${gpu.adapter}${gpu.fallback ? ' (fallback adapter)' : ''}, self-test ${gpu.renderMs} ms` : gpu.error),
  ];

  return {
    ok: required.every((item) => item.ok),
    required,
    optional,
    renderer: 'WebGL2',
    webgl: gl,
    webgpu: gpu,
    cores: navigator.hardwareConcurrency || 0,
    memoryGB: navigator.deviceMemory || 0,
    mobile: /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent)),
    userAgent: navigator.userAgent,
  };
}
