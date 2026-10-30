#version 300 es

precision highp float;
precision highp int;
precision highp sampler2D;

in vec3 vGenerated;

uniform sampler2D uPaperTexture;

struct VoicePalette {
  vec4 shadowColor;
  vec4 midLowColor;
  vec4 midHighColor;
  vec4 highlightColor;
};

const float materialShadowBrightness = 0.9465623;
const float materialMidLowBrightness = 0.89882153;
const float materialMidHighBrightness = 1.0;
const float materialHighlightBrightness = 0.63704175;

VoicePalette materialPaletteForAccent(vec3 accent) {

  if (all(equal(accent, vec3(0.0)))) {
    accent = vec3(0.08);
  }
  vec3 softLightCurve = mix(
    ((16.0 * accent - 12.0) * accent + 4.0) * accent,
    sqrt(accent),
    greaterThan(accent, vec3(0.25))
  );
  return VoicePalette(
    vec4(max(vec3(0.0), accent + materialShadowBrightness - 1.0), 1.0),
    vec4(accent + (2.0 * materialMidLowBrightness - 1.0) * (softLightCurve - accent), 1.0),
    vec4(1.0 - (1.0 - accent) * (1.0 - materialMidHighBrightness), 1.0),
    vec4(1.0 - (1.0 - accent) * (1.0 - materialHighlightBrightness), 1.0)
  );
}

const float materialMidLowRampStart = 0.3522728383541107;
const float materialMidLowRampEnd = 0.7400000095367432;
const float materialMidHighRampStart = 0.4113636016845703;
const float materialMidHighRampEnd = 0.5586364269256592;
const float materialHighlightRampStart = 0.3431819975376129;
const float materialHighlightRampEnd = 0.6200000047683716;

layout(std140) uniform VoiceSurfaceUniforms {
  float waveFrame;
  float baseShaderFrame;
  float waveAmplitude;
  float textureFlowFrame;
  float textureEdgeWarp;
  float listeningTextureNoiseScale;
  vec2 speakingWatercolorOffset0;
  vec2 speakingWatercolorOffset1;
  vec2 speakingWatercolorOffset2;
  vec4 accentColor;
} ubo;

#define uWaveFrame ubo.waveFrame
#define uBaseShaderFrame ubo.baseShaderFrame
#define uWaveAmplitude ubo.waveAmplitude
#define uTextureFlowFrame ubo.textureFlowFrame
#define uTextureEdgeWarp ubo.textureEdgeWarp
#define uListeningTextureNoiseScale ubo.listeningTextureNoiseScale
#define uSpeakingWatercolorOffset0 ubo.speakingWatercolorOffset0
#define uSpeakingWatercolorOffset1 ubo.speakingWatercolorOffset1
#define uSpeakingWatercolorOffset2 ubo.speakingWatercolorOffset2
#define uAccentColor ubo.accentColor

out vec4 fragColor;

vec3 rotateX(vec3 value, float angle) {
  float c = cos(angle);
  float s = sin(angle);
  return vec3(value.x, c * value.y - s * value.z, s * value.y + c * value.z);
}

vec3 rotateY(vec3 value, float angle) {
  float c = cos(angle);
  float s = sin(angle);
  return vec3(c * value.x + s * value.z, value.y, -s * value.x + c * value.z);
}

vec3 rotateZ(vec3 value, float angle) {
  float c = cos(angle);
  float s = sin(angle);
  return vec3(c * value.x - s * value.y, s * value.x + c * value.y, value.z);
}

vec3 rotateEulerXYZ(vec3 value, vec3 rotation) {
  vec3 transformed = rotateX(value, rotation.x);
  transformed = rotateY(transformed, rotation.y);
  transformed = rotateZ(transformed, rotation.z);
  return transformed;
}

vec3 mappingPoint(vec3 value, vec3 location, vec3 rotation, vec3 scale) {
  return rotateEulerXYZ(value * scale, rotation) + location;
}

float hash2ToFloat(vec2 value) {
  return fract(sin(dot(value, vec2(127.1, 311.7))) * 43758.5453);
}

vec2 hash2ToVec2(vec2 value) {
  return vec2(
    hash2ToFloat(value),
    hash2ToFloat(value + vec2(19.19, 73.73))
  );
}

float valueNoise2(vec2 value) {
  vec2 cell = floor(value);
  vec2 fraction = fract(value);
  vec2 curve = fraction * fraction * (3.0 - 2.0 * fraction);
  float lower = mix(
    hash2ToFloat(cell),
    hash2ToFloat(cell + vec2(1.0, 0.0)),
    curve.x
  );
  float upper = mix(
    hash2ToFloat(cell + vec2(0.0, 1.0)),
    hash2ToFloat(cell + vec2(1.0, 1.0)),
    curve.x
  );
  return mix(lower, upper, curve.y);
}

float noiseFbm2(vec2 value, float roughness, float lacunarity) {
  float firstOctave = valueNoise2(value);
  float secondOctave = valueNoise2(value * lacunarity + vec2(17.17, 31.31));
  float thirdOctave = valueNoise2(
    value * lacunarity * lacunarity + vec2(47.47, 11.11)
  );
  float secondAmplitude = roughness;
  float thirdAmplitude = roughness * roughness;
  return (
    firstOctave +
    secondOctave * secondAmplitude +
    thirdOctave * thirdAmplitude
  ) / (1.0 + secondAmplitude + thirdAmplitude);
}

vec3 noiseColor4Detail2Normalized(
  vec3 coordinate,
  float w,
  float scale,
  float roughness,
  float lacunarity,
  bool normalizeTimeDirection
) {
  vec2 point = coordinate.xy * scale;
  float time = w * scale;
  vec2 firstDirection = vec2(0.17, 0.11);
  vec2 secondDirection = vec2(-0.13, 0.19);
  vec2 thirdDirection = vec2(0.07, -0.23);

  if (normalizeTimeDirection) {
    firstDirection = normalize(firstDirection);
    secondDirection = normalize(secondDirection);
    thirdDirection = normalize(thirdDirection);
  }

  return vec3(
    noiseFbm2(point + firstDirection * time, roughness, lacunarity),
    noiseFbm2(
      point + vec2(41.41, 17.17) + secondDirection * time,
      roughness,
      lacunarity
    ),
    noiseFbm2(
      point + vec2(23.23, 59.59) + thirdDirection * time,
      roughness,
      lacunarity
    )
  );
}

vec3 animatedColorRampWarp(vec3 coordinate, float frame) {
  vec2 point = coordinate.xy * 8.0;
  vec2 cell = floor(point);
  vec2 localPosition = fract(point);
  vec2 nearestPosition = vec2(0.0);
  float nearestDistance = 3.402823466e+38;
  float animationPhase = frame * 2.0 * 3.14159265 / 240.0;

  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 cellOffset = vec2(float(x), float(y));
      vec2 randomPosition = hash2ToVec2(cell + cellOffset);
      vec2 animatedPosition = cellOffset +
        randomPosition * 0.7185189723968506 +
        sin(vec2(animationPhase) + randomPosition * 6.2831853) * 0.04;
      vec2 delta = animatedPosition - localPosition;
      float distanceSquared = dot(delta, delta);

      if (distanceSquared < nearestDistance) {
        nearestDistance = distanceSquared;
        nearestPosition = animatedPosition;
      }
    }
  }

  vec3 voronoiPosition = vec3((nearestPosition + cell) / 8.0, coordinate.z);
  vec3 continuousWarp =
    (coordinate - vec3(0.5)) * 0.25999999046325684;
  vec3 cellularWarp = (voronoiPosition - coordinate) * 0.06;
  return continuousWarp + cellularWarp;
}

vec4 ramp_color_ramp_006(float fac) {
  if (fac <= materialHighlightRampStart) {
    return vec4(1.0, 1.0, 1.0, 1.0);
  }
  if (fac <= materialHighlightRampEnd) {
    float t = clamp((fac - materialHighlightRampStart) / max(materialHighlightRampEnd - materialHighlightRampStart, 0.000001), 0.0, 1.0);
    t = t * t * (3.0 - 2.0 * t);
    return mix(vec4(1.0, 1.0, 1.0, 1.0), vec4(0.0, 0.0, 0.0, 1.0), t);
  }
  return vec4(0.0, 0.0, 0.0, 1.0);
}

vec4 ramp_color_ramp_005(float fac) {
  if (fac <= materialMidHighRampStart) {
    return vec4(1.0, 1.0, 1.0, 1.0);
  }
  if (fac <= materialMidHighRampEnd) {
    float t = clamp((fac - materialMidHighRampStart) / max(materialMidHighRampEnd - materialMidHighRampStart, 0.000001), 0.0, 1.0);
    t = t * t * (3.0 - 2.0 * t);
    return mix(vec4(1.0, 1.0, 1.0, 1.0), vec4(0.0, 0.0, 0.0, 1.0), t);
  }
  return vec4(0.0, 0.0, 0.0, 1.0);
}

vec4 ramp_color_ramp_009(float fac) {
  if (fac <= materialMidLowRampStart) {
    return vec4(1.0, 1.0, 1.0, 1.0);
  }
  if (fac <= materialMidLowRampEnd) {
    float t = clamp((fac - materialMidLowRampStart) / max(materialMidLowRampEnd - materialMidLowRampStart, 0.000001), 0.0, 1.0);
    t = t * t * (3.0 - 2.0 * t);
    return mix(vec4(1.0, 1.0, 1.0, 1.0), vec4(0.0, 0.0, 0.0, 1.0), t);
  }
  return vec4(0.0, 0.0, 0.0, 1.0);
}

vec4 ramp_color_ramp_007(float fac) {
  if (fac <= 0.0) {
    return vec4(1.0, 1.0, 1.0, 1.0);
  }
  if (fac <= 1.0) {
    return vec4(1.0, 1.0, 1.0, 1.0);
  }
  return vec4(0.0, 0.0, 0.0, 1.0);
}

void main() {
  VoicePalette materialPalette = materialPaletteForAccent(uAccentColor.rgb);
  vec4 materialShadowColor = materialPalette.shadowColor;
  vec4 materialMidLowColor = materialPalette.midLowColor;
  vec4 materialMidHighColor = materialPalette.midHighColor;
  vec4 materialHighlightColor = materialPalette.highlightColor;
  float frame = uBaseShaderFrame;
  float waveFrame = uWaveFrame;
  float textureFlowFrame = uTextureFlowFrame;


  vec3 scaledGenerated = vGenerated;
  vec3 materialNode1 = scaledGenerated;
vec3 materialNode2 = mappingPoint(materialNode1, vec3(0.0, -0.14000000059604645, 0.0), vec3(0.0, 0.0, 0.0), vec3(1.0, 1.0, 1.0));
  vec2 textureEdgeCentered = scaledGenerated.xy - vec2(0.5);
  float textureEdgeRadius = length(textureEdgeCentered);
  float textureEdgeWeight = smoothstep(0.015, 0.44, textureEdgeRadius);
  vec2 textureEdgeDirection = textureEdgeRadius > 0.000001
    ? textureEdgeCentered / textureEdgeRadius
    : vec2(0.0);
  materialNode2.xy += textureEdgeDirection * textureEdgeWeight * uTextureEdgeWarp;
float materialNode3 = waveFrame / 100.0;
vec3 materialNode4 = noiseColor4Detail2Normalized(materialNode2, materialNode3, 1.0, 0.4000000059604645, 2.0, true);
vec3 materialNode5 = materialNode4 - vec3(0.5, 0.5, 0.5);
float materialNode6 = (0.800000011920929) * uWaveAmplitude;
vec3 materialNode7 = materialNode5 * materialNode6;
vec3 materialNode8 = materialNode2 + materialNode7;
vec3 materialNode9 = noiseColor4Detail2Normalized(materialNode8, textureFlowFrame / 10.0, 4000.0, 0.5, 2.0, false);
vec3 materialNode10 = (materialNode9 - vec3(0.5, 0.5, 0.5)) * uListeningTextureNoiseScale;
vec3 materialNode11 = materialNode10 * 0.05999999865889549;
float materialNode12 = 0.800000011920929;
vec3 materialNode13 = materialNode8 * materialNode12;
vec3 materialNode14 = materialNode11 + materialNode13;
  materialNode14.xy += uSpeakingWatercolorOffset0;
vec4 materialNode15 = textureGrad(uPaperTexture, (materialNode14).xy, dFdx((materialNode14).xy) * (1.0 / 1.5), dFdy((materialNode14).xy) * (1.0 / 1.5));
float materialNode16 = (materialNode15).r - 0.5;
vec3 materialNode17 = materialNode13;
vec3 materialNode18 = materialNode11 + materialNode17;
float materialNode19 = 1.0 - (materialNode18).y;
vec3 materialNode20 = vec3((materialNode18).x, materialNode19, 0.0);
  materialNode20.xy += uSpeakingWatercolorOffset0;
vec4 materialNode21 = textureGrad(uPaperTexture, (materialNode20).xy, dFdx((materialNode20).xy) * (1.0 / 1.5), dFdy((materialNode20).xy) * (1.0 / 1.5));
float materialNode22 = (materialNode21).r - 0.5;
float baseShaderFrameBlend120 =
  clamp(0.5 - 0.5*cos(frame * 2.0 * 3.14159265 / 120.0), 0.0, 1.0);
float materialNode23 = mix(materialNode16, materialNode22, baseShaderFrameBlend120);
float materialNode24 = 0.2 - 0.06*cos((frame - 1.0) * 2.0 * 3.14159265 / 120.0);
float materialNode25 = materialNode23 * materialNode24;
vec3 materialNode26 = vec3(materialNode25, materialNode25, 0.0);
vec3 materialNode27 = animatedColorRampWarp(materialNode8, frame);
vec3 materialNode28 = materialNode26 + materialNode27;
vec3 materialNode29 = materialNode8 + materialNode28;
vec3 materialNode30 = mappingPoint(materialNode29, vec3(0.0, 0.5600000023841858, 0.0), vec3(0.0, 0.7853981852531433, 0.0), vec3(1.0, 1.0, 1.0));
vec4 materialNode31 = ramp_color_ramp_006(((materialNode30).x + (materialNode30).y + (materialNode30).z) / 3.0);
float materialNode32 = 0.800000011920929;
vec3 materialNode33 = mappingPoint(materialNode8, vec3(0.03999999910593033, 0.019999999552965164, 0.0), vec3(0.0, 0.0, 0.0), vec3(materialNode32));
vec3 materialNode34 = materialNode11 + materialNode33;
  materialNode34.xy += uSpeakingWatercolorOffset1;
vec4 materialNode35 = textureGrad(uPaperTexture, (materialNode34).xy, dFdx((materialNode34).xy) * (1.0 / 1.5), dFdy((materialNode34).xy) * (1.0 / 1.5));
float materialNode36 = (materialNode35).r - 0.5;
vec3 materialNode37 = mappingPoint(materialNode8, vec3(-0.03999999910593033, -0.019999999552965164, 0.0), vec3(0.0, 0.0, 0.0), vec3(materialNode32));
vec3 materialNode38 = materialNode11 + materialNode37;
float materialNode39 = 1.0 - (materialNode38).y;
vec3 materialNode40 = vec3((materialNode38).x, materialNode39, 0.0);
  materialNode40.xy += uSpeakingWatercolorOffset1;
vec4 materialNode41 = textureGrad(uPaperTexture, (materialNode40).xy, dFdx((materialNode40).xy) * (1.0 / 1.5), dFdy((materialNode40).xy) * (1.0 / 1.5));
float materialNode42 = (materialNode41).r - 0.5;
float materialNode43 = mix(materialNode36, materialNode42, baseShaderFrameBlend120);
float materialNode44 = 0.2 - 0.06*cos((frame - 1.0) * 2.0 * 3.14159265 / 80.0);
float materialNode45 = materialNode43 * materialNode44;
vec3 materialNode46 = vec3(materialNode45, materialNode45, 0.0);
vec3 materialNode47 = materialNode46 + materialNode27;
vec3 materialNode48 = materialNode8 + materialNode47;
vec3 materialNode49 = mappingPoint(materialNode48, vec3(0.0, 0.25999999046325684, 0.0), vec3(0.0, 0.7853981852531433, 0.0), vec3(1.0, 1.0, 1.0));
vec4 materialNode50 = ramp_color_ramp_005(((materialNode49).x + (materialNode49).y + (materialNode49).z) / 3.0);
vec3 materialNode51 = scaledGenerated;
vec3 materialNode52 = mappingPoint(materialNode51, vec3(-0.3199999928474426, 0.0, 0.0), vec3(0.0, 0.0, -1.5707963705062866), vec3(1.0, 1.0, 1.0));
float materialNode53 = clamp((materialNode52).x, 0.0, 1.0);
float materialNode54 = materialNode53 * materialNode53
  * (3.0 - 2.0 * materialNode53);
float materialNode55 = 0.800000011920929;
vec3 materialNode56 = mappingPoint(materialNode8, vec3(-0.07999999821186066, -0.03999999910593033, 0.0), vec3(0.0, 0.0, 0.0), vec3(materialNode55));
vec3 materialNode57 = materialNode11 + materialNode56;
  materialNode57.xy += uSpeakingWatercolorOffset2;
vec4 materialNode58 = textureGrad(uPaperTexture, (materialNode57).xy, dFdx((materialNode57).xy) * (1.0 / 1.5), dFdy((materialNode57).xy) * (1.0 / 1.5));
vec4 materialNode59 = mix(materialNode58, vec4(1.0, 1.0, 1.0, 1.0), clamp(((vec4(vec3(materialNode54), 1.0)).r + (vec4(vec3(materialNode54), 1.0)).g + (vec4(vec3(materialNode54), 1.0)).b) / 3.0, 0.0, 1.0));
float materialNode60 = (materialNode59).r - 0.5;
vec3 materialNode61 = mappingPoint(materialNode8, vec3(-0.9599999189376831, 0.05999999865889549, 0.0), vec3(0.0, 0.0, 0.0), vec3(materialNode55));
vec3 materialNode62 = materialNode11 + materialNode61;
float materialNode63 = 1.0 - (materialNode62).y;
vec3 materialNode64 = vec3((materialNode62).x, materialNode63, 0.0);
  materialNode64.xy += uSpeakingWatercolorOffset2;
vec4 materialNode65 = textureGrad(uPaperTexture, (materialNode64).xy, dFdx((materialNode64).xy) * (1.0 / 1.5), dFdy((materialNode64).xy) * (1.0 / 1.5));
vec4 materialNode66 = mix(materialNode65, vec4(1.0, 1.0, 1.0, 1.0), clamp(((vec4(vec3(materialNode54), 1.0)).r + (vec4(vec3(materialNode54), 1.0)).g + (vec4(vec3(materialNode54), 1.0)).b) / 3.0, 0.0, 1.0));
float materialNode67 = (materialNode66).r - 0.5;
float materialNode68 = mix(materialNode60, materialNode67, baseShaderFrameBlend120);
float materialNode69 = 0.14 - 0.06*cos((frame - 1.0) * 2.0 * 3.14159265 / 100.0);
float materialNode70 = materialNode68 * materialNode69;
vec3 materialNode71 = vec3(materialNode70, materialNode70, 0.0);
vec3 materialNode72 = materialNode71 + materialNode27;
vec3 materialNode73 = materialNode8 + materialNode72;
vec3 materialNode74 = mappingPoint(materialNode73, vec3(0.0, 0.12000000476837158, 0.0), vec3(0.0, 0.7853981852531433, 0.0), vec3(1.0, 1.0, 1.0));
vec4 materialNode75 = ramp_color_ramp_009(((materialNode74).x + (materialNode74).y + (materialNode74).z) / 3.0);
vec3 materialNode76 = scaledGenerated;
vec3 materialNode77 = mappingPoint(materialNode76, vec3(0.0, 0.0, 0.0), vec3(0.0, 0.0, 0.0), vec3(1.0, 1.0, 1.0));
vec4 materialNode78 = ramp_color_ramp_007(((materialNode77).x + (materialNode77).y + (materialNode77).z) / 3.0);
vec4 materialNode79 = mix(vec4(0.0, 0.0, 0.0, 1.0), materialShadowColor, clamp(((materialNode78).r + (materialNode78).g + (materialNode78).b) / 3.0, 0.0, 1.0));
vec4 materialNode80 = mix(materialNode79, materialMidLowColor, clamp(((materialNode75).r + (materialNode75).g + (materialNode75).b) / 3.0, 0.0, 1.0));
vec4 materialNode81 = mix(materialNode80, materialMidHighColor, clamp(((materialNode50).r + (materialNode50).g + (materialNode50).b) / 3.0, 0.0, 1.0));
vec4 materialNode82 = mix(materialNode81, materialHighlightColor, clamp(((materialNode31).r + (materialNode31).g + (materialNode31).b) / 3.0, 0.0, 1.0));
vec4 materialColor = vec4((materialNode82).rgb, 1.0);
  fragColor = materialColor;
}
