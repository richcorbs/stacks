const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    const exe = b.addExecutable(.{
        .name = "stacks",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/main.zig"),
            .target = target,
            .optimize = optimize,
            .link_libc = true,
        }),
    });

    // --- libvterm (vendored, compiled from source) ---
    const vterm_include = b.path("vendor/libvterm/include");
    const vterm_src_include = b.path("vendor/libvterm/src");
    exe.root_module.addIncludePath(vterm_include);

    const vterm_sources = [_][]const u8{
        "vendor/libvterm/src/encoding.c",
        "vendor/libvterm/src/keyboard.c",
        "vendor/libvterm/src/mouse.c",
        "vendor/libvterm/src/parser.c",
        "vendor/libvterm/src/pen.c",
        "vendor/libvterm/src/screen.c",
        "vendor/libvterm/src/state.c",
        "vendor/libvterm/src/unicode.c",
        "vendor/libvterm/src/vterm.c",
    };
    for (vterm_sources) |src| {
        exe.addCSourceFile(.{
            .file = b.path(src),
            .flags = &.{ "-std=c99", "-DINLINE=static inline", "-DHAVE_CURSES", "-DHAVE_UNIBILIUM" },
        });
    }
    // vterm_internal.h includes from its own directory
    exe.root_module.addIncludePath(vterm_src_include);

    // --- Embed version string from VERSION file ---
    const version_file = b.path("VERSION");
    exe.root_module.addAnonymousImport("version", .{ .root_source_file = version_file });

    // --- macOS frameworks ---
    exe.linkFramework("AppKit");
    exe.linkFramework("QuartzCore");
    exe.linkFramework("CoreGraphics");
    exe.linkFramework("CoreText");
    exe.linkFramework("Foundation");
    exe.linkFramework("Speech");
    exe.linkFramework("AVFoundation");
    exe.linkFramework("CoreAudio");

    // Compile ObjC helper for speech recognition (requires blocks)
    exe.addCSourceFile(.{
        .file = b.path("src/speech_helper.m"),
        .flags = &.{"-fobjc-arc"},
    });

    b.installArtifact(exe);

    // --- Run step ---
    const run_cmd = b.addRunArtifact(exe);
    run_cmd.step.dependOn(b.getInstallStep());
    if (b.args) |args| run_cmd.addArgs(args);

    const run_step = b.step("run", "Build and run Stacks");
    run_step.dependOn(&run_cmd.step);

    // --- Tests ---
    const unit_tests = b.addTest(.{
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/main.zig"),
            .target = target,
            .optimize = optimize,
        }),
    });
    const run_unit_tests = b.addRunArtifact(unit_tests);
    const test_step = b.step("test", "Run unit tests");
    test_step.dependOn(&run_unit_tests.step);
}
