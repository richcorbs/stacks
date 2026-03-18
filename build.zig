const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    // Path to a local ghostty checkout (set via -Dghostty-path=... or env)
    const ghostty_path = b.option(
        []const u8,
        "ghostty-path",
        "Path to ghostty source checkout (contains include/ and lib/)",
    ) orelse "vendor/ghostty";

    const exe = b.addExecutable(.{
        .name = "my-term",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/main.zig"),
            .target = target,
            .optimize = optimize,
            .link_libc = true,
        }),
    });

    // --- libghostty linkage ---
    exe.root_module.addIncludePath(.{ .cwd_relative = b.fmt("{s}/include", .{ghostty_path}) });
    exe.root_module.addLibraryPath(.{ .cwd_relative = b.fmt("{s}/lib", .{ghostty_path}) });
    exe.linkSystemLibrary("ghostty");

    // --- libvterm linkage ---
    exe.root_module.addIncludePath(.{ .cwd_relative = "/opt/homebrew/include" });
    exe.root_module.addLibraryPath(.{ .cwd_relative = "/opt/homebrew/lib" });
    exe.linkSystemLibrary("vterm");

    // --- macOS frameworks ---
    exe.linkFramework("AppKit");
    exe.linkFramework("Metal");
    exe.linkFramework("MetalKit");
    exe.linkFramework("QuartzCore");
    exe.linkFramework("CoreGraphics");
    exe.linkFramework("CoreText");
    exe.linkFramework("Foundation");

    b.installArtifact(exe);

    // --- Run step ---
    const run_cmd = b.addRunArtifact(exe);
    run_cmd.step.dependOn(b.getInstallStep());
    if (b.args) |args| run_cmd.addArgs(args);

    const run_step = b.step("run", "Build and run my-term");
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
