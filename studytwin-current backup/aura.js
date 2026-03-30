class AuraBackground {
  constructor(canvasId) {
    this.canvas = document.getElementById(canvasId);
    if (!this.canvas) return;
    
    this.gl = this.canvas.getContext('webgl', { alpha: true, antialias: true }) || this.canvas.getContext('experimental-webgl');
    if (!this.gl) return;

    this.targetColor = [37/255, 99/255, 235/255]; // Cobalt
    this.currentColor = [37/255, 99/255, 235/255];
    this.mouse = { x: 0.5, y: 0.5, targetX: 0.5, targetY: 0.5 };
    this.time = 0;
    
    this.init();
    this.animate();
    this.bindEvents();
  }

  init() {
    const gl = this.gl;
    
    const vsSource = `
      attribute vec2 position;
      void main() {
        gl_Position = vec4(position, 0.0, 1.0);
      }
    `;

    const fsSource = `
      precision highp float;
      uniform float uTime;
      uniform vec2 uResolution;
      uniform vec2 uMouse;
      uniform vec3 uColor;

      // Simplex 3D Noise 
      // by Ian McEwan, Ashima Arts
      vec4 permute(vec4 x){return mod(((x*34.0)+1.0)*x, 289.0);}
      vec4 taylorInvSqrt(vec4 r){return 1.79284291400159 - 0.85373472095314 * r;}

      float snoise(vec3 v){ 
        const vec2  C = vec2(1.0/6.0, 1.0/3.0) ;
        const vec4  D = vec4(0.0, 0.5, 1.0, 2.0);

        vec3 i  = floor(v + dot(v, C.yyy) );
        vec3 x0 = v - i + dot(i, C.xxx) ;

        vec3 g = step(x0.yzx, x0.xyz);
        vec3 l = 1.0 - g;
        vec3 i1 = min( g.xyz, l.zxy );
        vec3 i2 = max( g.xyz, l.zxy );

        vec3 x1 = x0 - i1 + 1.0 * C.xxx;
        vec3 x2 = x0 - i2 + 2.0 * C.xxx;
        vec3 x3 = x0 - 1.0 + 3.0 * C.xxx;

        i = mod(i, 289.0 ); 
        vec4 p = permute( permute( permute( 
                   i.z + vec4(0.0, i1.z, i2.z, 1.0 ))
                 + i.y + vec4(0.0, i1.y, i2.y, 1.0 )) 
                 + i.x + vec4(0.0, i1.x, i2.x, 1.0 ));

        float n_ = 1.0/7.0;
        vec3  ns = n_ * D.wyz - D.xzx;

        vec4 j = p - 49.0 * floor(p * ns.z *ns.z);

        vec4 x_ = floor(j * ns.z);
        vec4 y_ = floor(j - 7.0 * x_ );

        vec4 x = x_ *ns.x + ns.yyyy;
        vec4 y = y_ *ns.x + ns.yyyy;
        vec4 h = 1.0 - abs(x) - abs(y);

        vec4 b0 = vec4( x.xy, y.xy );
        vec4 b1 = vec4( x.zw, y.zw );

        vec4 s0 = floor(b0)*2.0 + 1.0;
        vec4 s1 = floor(b1)*2.0 + 1.0;
        vec4 sh = -step(h, vec4(0.0));

        vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy ;
        vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww ;

        vec3 p0 = vec3(a0.xy,h.x);
        vec3 p1 = vec3(a0.zw,h.y);
        vec3 p2 = vec3(a1.xy,h.z);
        vec3 p3 = vec3(a1.zw,h.w);

        vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2, p2), dot(p3,p3)));
        p0 *= norm.x;
        p1 *= norm.y;
        p2 *= norm.z;
        p3 *= norm.w;

        vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
        m = m * m;
        return 42.0 * dot( m*m, vec4( dot(p0,x0), dot(p1,x1), 
                                      dot(p2,x2), dot(p3,x3) ) );
      }

      void main() {
        vec2 uv = gl_FragCoord.xy / uResolution.xy;
        vec2 p = uv * 2.0 - 1.0;
        p.x *= uResolution.x / uResolution.y;

        vec2 mouse = uMouse * 2.0 - 1.0;
        mouse.x *= uResolution.x / uResolution.y;

        // Mouse distance
        float dist = length(p - mouse);
        float mouseGlow = exp(-dist * 2.5);

        // Fluid distortion
        vec3 pos = vec3(p * 1.2, uTime * 0.1);
        float noise1 = snoise(pos);
        float noise2 = snoise(pos + vec3(noise1 * 0.5, mouseGlow * 0.5, uTime * 0.2));
        float noise3 = snoise(pos + vec3(noise2 * 0.8, -noise1 * 0.3, uTime * 0.15));

        // Color mixing
        vec3 color1 = uColor; // Base
        vec3 color2 = uColor * 0.4 + vec3(0.1); // Darker/desaturated
        vec3 color3 = uColor * 1.5; // Highlight

        float mix1 = smoothstep(-1.0, 1.0, noise2);
        float mix2 = smoothstep(-0.5, 1.0, noise3);

        vec3 finalColor = mix(color2, color1, mix1);
        finalColor = mix(finalColor, color3, mix2 * 0.5);

        // Add mouse glow
        finalColor += uColor * mouseGlow * 0.6;

        // Vignette
        float vignette = 1.0 - smoothstep(0.4, 1.8, length(p));
        finalColor *= vignette;

        // Opacity
        float alpha = (mix1 * 0.5 + 0.5) * vignette;
        
        gl_FragColor = vec4(finalColor, alpha * 0.6);
      }
    `;

    const vertexShader = this.compileShader(gl.VERTEX_SHADER, vsSource);
    const fragmentShader = this.compileShader(gl.FRAGMENT_SHADER, fsSource);

    this.program = gl.createProgram();
    gl.attachShader(this.program, vertexShader);
    gl.attachShader(this.program, fragmentShader);
    gl.linkProgram(this.program);
    gl.useProgram(this.program);

    const vertices = new Float32Array([
      -1, -1,  1, -1,  -1, 1,
      -1,  1,  1, -1,   1, 1
    ]);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);

    const positionLocation = gl.getAttribLocation(this.program, "position");
    gl.enableVertexAttribArray(positionLocation);
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

    this.uTime = gl.getUniformLocation(this.program, "uTime");
    this.uResolution = gl.getUniformLocation(this.program, "uResolution");
    this.uMouse = gl.getUniformLocation(this.program, "uMouse");
    this.uColor = gl.getUniformLocation(this.program, "uColor");

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  compileShader(type, source) {
    const shader = this.gl.createShader(type);
    this.gl.shaderSource(shader, source);
    this.gl.compileShader(shader);
    if (!this.gl.getShaderParameter(shader, this.gl.COMPILE_STATUS)) {
      console.error(this.gl.getShaderInfoLog(shader));
      this.gl.deleteShader(shader);
      return null;
    }
    return shader;
  }

  resize() {
    this.canvas.width = window.innerWidth;
    this.canvas.height = window.innerHeight;
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    this.gl.uniform2f(this.uResolution, this.canvas.width, this.canvas.height);
  }

  bindEvents() {
    window.addEventListener('mousemove', (e) => {
      this.mouse.targetX = e.clientX / window.innerWidth;
      this.mouse.targetY = 1.0 - (e.clientY / window.innerHeight);
    });
  }

  setCLI(cliScore) {
    if (cliScore < 30) {
      this.targetColor = [16/255, 185/255, 129/255]; // Emerald
    } else if (cliScore < 70) {
      this.targetColor = [37/255, 99/255, 235/255]; // Cobalt
    } else {
      this.targetColor = [217/255, 119/255, 6/255]; // Amber
    }
  }

  animate() {
    requestAnimationFrame(() => this.animate());
    
    this.time += 0.01;
    
    this.mouse.x += (this.mouse.targetX - this.mouse.x) * 0.05;
    this.mouse.y += (this.mouse.targetY - this.mouse.y) * 0.05;

    for(let i=0; i<3; i++) {
      this.currentColor[i] += (this.targetColor[i] - this.currentColor[i]) * 0.02;
    }

    this.gl.uniform1f(this.uTime, this.time);
    this.gl.uniform2f(this.uMouse, this.mouse.x, this.mouse.y);
    this.gl.uniform3f(this.uColor, this.currentColor[0], this.currentColor[1], this.currentColor[2]);

    // Clear with transparent black
    this.gl.clearColor(0, 0, 0, 0);
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);

    // Enable blending
    this.gl.enable(this.gl.BLEND);
    this.gl.blendFunc(this.gl.SRC_ALPHA, this.gl.ONE_MINUS_SRC_ALPHA);

    this.gl.drawArrays(this.gl.TRIANGLES, 0, 6);
  }
}

window.AuraBackground = AuraBackground;
