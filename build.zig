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

    // --- libvterm (Homebrew) ---
    exe.root_module.addIncludePath(.{ .cwd_relative = "/opt/homebrew/Cellar/libvterm/0.3.3/include" });
    exe.root_module.addLibraryPath(.{ .cwd_relative = "/opt/homebrew/Cellar/libvterm/0.3.3/lib" });
    exe.linkSystemLibrary("vterm");

    // --- Embed version string from VERSION file ---
    const version_file = b.path("VERSION");
    exe.root_module.addAnonymousImport("version", .{ .root_source_file = version_file });

    // --- macOS frameworks ---
    exe.linkFramework("AppKit");
    exe.linkFramework("QuartzCore");
    exe.linkFramework("CoreGraphics");
    exe.linkFramework("CoreText");
    exe.linkFramework("Foundation");

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
