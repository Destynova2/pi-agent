import Foundation
import Metal

guard let device = MTLCreateSystemDefaultDevice() else {
    print("METAL_UNAVAILABLE")
    exit(77)
}
let source = """
#include <metal_stdlib>
using namespace metal;
kernel void doubleValues(device float *values [[buffer(0)]], uint i [[thread_position_in_grid]]) {
    values[i] *= 2.0;
}
"""
let library = try device.makeLibrary(source: source, options: nil)
let pipeline = try device.makeComputePipelineState(function: library.makeFunction(name: "doubleValues")!)
var values: [Float] = [1, 2, 3, 4]
let buffer = device.makeBuffer(bytes: &values, length: values.count * MemoryLayout<Float>.stride, options: .storageModeShared)!
let command = device.makeCommandQueue()!.makeCommandBuffer()!
let encoder = command.makeComputeCommandEncoder()!
encoder.setComputePipelineState(pipeline)
encoder.setBuffer(buffer, offset: 0, index: 0)
encoder.dispatchThreads(MTLSize(width: values.count, height: 1, depth: 1), threadsPerThreadgroup: MTLSize(width: 1, height: 1, depth: 1))
encoder.endEncoding()
command.commit()
command.waitUntilCompleted()
guard command.status == .completed else { throw command.error ?? NSError(domain: "MetalProbe", code: 1) }
let result = Array(UnsafeBufferPointer(start: buffer.contents().assumingMemoryBound(to: Float.self), count: values.count))
guard result == [2, 4, 6, 8] else { exit(1) }
print("METAL_COMPUTE_OK \(result)")
