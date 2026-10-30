// A pending Promise alone does not keep Node alive. Test entry points must set
// their final status only after assertions and owned-resource cleanup complete.
process.exitCode = 1;
