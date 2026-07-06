/**
 * render.buildFilterGraph 单测：验证 gtrk EDL → filter_complex 的移植语义
 * （视频 trim+scale+pad+concat / 音频 atrim+aresample+afade+concat / 单音轨 anull / gap 补黑场 / 无音轨全静音）。
 * 这也是与后端 build_filter_graph 黄金用例对拍的本地基线（change tasks §8.4，待后端导出向量后逐文本比对）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFilterGraph } from "../.test-build/render.mjs";

const V = "1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black,setsar=1,format=yuv420p";

test("单源单轨：视频 trim+concat + 音频 afade+concat + 单音轨 anull", () => {
	const gtrk = {
		video_size: [1920, 1080],
		video_rate: 30,
		materials: [{ id: "m1", path: "/x.mp4" }],
		video_track: [
			{
				track_index: 0,
				track_timeline: [
					{ material: "m1", clip_st: 1.0, clip_ed: 2.0, track_st: 0.0, track_ed: 1.0, duration: 1.0 },
					{ material: "m1", clip_st: 5.0, clip_ed: 6.5, track_st: 1.0, track_ed: 2.5, duration: 1.5 },
				],
			},
		],
		audio_track: [
			{
				track_index: 0,
				track_timeline: [
					{ material: "m1", clip_st: 1.0, clip_ed: 2.0, track_st: 0.0, track_ed: 1.0, duration: 1.0 },
					{ material: "m1", clip_st: 5.0, clip_ed: 6.5, track_st: 1.0, track_ed: 2.5, duration: 1.5 },
				],
			},
		],
	};
	const { inputs, graph, total } = buildFilterGraph(gtrk, { m1: "/x.mp4" });
	assert.deepEqual(inputs, ["/x.mp4"]);
	assert.equal(total, 2.5);
	const expected = [
		`[0:v]trim=start=1.000000:end=2.000000,setpts=PTS-STARTPTS,fps=30,scale=${V}[s1]`,
		`[0:v]trim=start=5.000000:end=6.500000,setpts=PTS-STARTPTS,fps=30,scale=${V}[s2]`,
		`[s1][s2]concat=n=2:v=1:a=0[vout]`,
		`[0:a]atrim=start=1.000000:end=2.000000,asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,afade=t=in:d=0.008,afade=t=out:st=0.992000:d=0.008[s3]`,
		`[0:a]atrim=start=5.000000:end=6.500000,asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,afade=t=in:d=0.008,afade=t=out:st=1.492000:d=0.008[s4]`,
		`[s3][s4]concat=n=2:v=0:a=1[s5]`,
		`[s5]anull[aout]`,
	].join(";");
	assert.equal(graph, expected);
});

test("无音轨 → 全静音 aout；素材缺路径抛错", () => {
	const gtrk = {
		video_size: [1280, 720],
		video_rate: 25,
		materials: [{ id: "m1", path: "/x.mp4" }],
		video_track: [{ track_timeline: [{ material: "m1", clip_st: 0, duration: 2, track_st: 0 }] }],
		audio_track: [],
	};
	const { graph, total } = buildFilterGraph(gtrk, { m1: "/x.mp4" });
	assert.equal(total, 2);
	assert.ok(graph.includes("anullsrc=r=48000:cl=stereo,atrim=end=2.000000[aout]"));
	// 引用了未提供路径的素材 → 抛错
	assert.throws(() => buildFilterGraph(gtrk, {}), /缺本地路径/);
});

test("视频轨短于音频轨 → 视频补黑场尾", () => {
	const gtrk = {
		video_size: [1920, 1080],
		video_rate: 30,
		materials: [{ id: "m1", path: "/x.mp4" }],
		video_track: [{ track_timeline: [{ material: "m1", clip_st: 0, duration: 1, track_st: 0 }] }],
		audio_track: [{ track_timeline: [{ material: "m1", clip_st: 0, duration: 3, track_st: 0 }] }],
	};
	const { graph, total } = buildFilterGraph(gtrk, { m1: "/x.mp4" });
	assert.equal(total, 3);
	// 视频轨尾部补 2s 黑场
	assert.ok(graph.includes("color=black:s=1920x1080:r=30:d=2.000000,format=yuv420p"));
});
