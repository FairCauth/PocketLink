using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

namespace PocketLink.WindowsAudio
{
    [StructLayout(LayoutKind.Sequential)]
    internal struct PropertyKey
    {
        public Guid Format;
        public uint Id;
        public PropertyKey(string format, uint id) { Format = new Guid(format); Id = id; }
    }
    [StructLayout(LayoutKind.Sequential)]
    internal struct PropertyValue
    {
        public ushort Type, Reserved1, Reserved2, Reserved3;
        public IntPtr Text, Reserved;
    }
    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    internal class DeviceEnumerator { }
    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IDeviceEnumerator
    {
        [PreserveSig] int EnumAudioEndpoints(int flow, uint state, out IDeviceCollection devices);
        [PreserveSig] int GetDefaultAudioEndpoint(int flow, int role, out IDevice device);
        [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IDevice device);
    }
    [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IDeviceCollection
    {
        [PreserveSig] int GetCount(out uint count);
        [PreserveSig] int Item(uint index, out IDevice device);
    }
    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IDevice
    {
        [PreserveSig] int Activate(ref Guid iid, uint context, IntPtr parameters, out IntPtr result);
        [PreserveSig] int OpenPropertyStore(uint access, out IPropertyStore store);
        [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
        [PreserveSig] int GetState(out uint state);
    }
    [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IPropertyStore
    {
        [PreserveSig] int GetCount(out uint count);
        [PreserveSig] int GetAt(uint index, out PropertyKey key);
        [PreserveSig] int GetValue(ref PropertyKey key, out PropertyValue value);
        [PreserveSig] int SetValue(ref PropertyKey key, ref PropertyValue value);
        [PreserveSig] int Commit();
    }
    // Windows 10/11 audio policy interface (not a public SDK contract). Keep its
    // slot order and the FX-store BOOL: omitting that argument corrupts the call.
    // ABI reference: frgnca/AudioDeviceCmdlets, SOURCE/IPolicyConfig.cs.
    [ComImport, Guid("870AF99C-171D-4F9E-AF0D-E63DF40C2BC9")]
    internal class PolicyConfigClient { }
    [ComImport, Guid("F8679F50-850A-41CF-9C72-430F290290C8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IPolicyConfig
    {
        [PreserveSig] int GetMixFormat([MarshalAs(UnmanagedType.LPWStr)] string id, IntPtr format);
        [PreserveSig] int GetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string id, [MarshalAs(UnmanagedType.Bool)] bool defaults, IntPtr format);
        [PreserveSig] int ResetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string id);
        [PreserveSig] int SetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string id, IntPtr endpoint, IntPtr mix);
        [PreserveSig] int GetProcessingPeriod([MarshalAs(UnmanagedType.LPWStr)] string id, [MarshalAs(UnmanagedType.Bool)] bool defaults, IntPtr period, IntPtr minimum);
        [PreserveSig] int SetProcessingPeriod([MarshalAs(UnmanagedType.LPWStr)] string id, IntPtr period);
        [PreserveSig] int GetShareMode([MarshalAs(UnmanagedType.LPWStr)] string id, IntPtr mode);
        [PreserveSig] int SetShareMode([MarshalAs(UnmanagedType.LPWStr)] string id, IntPtr mode);
        [PreserveSig] int GetPropertyValue([MarshalAs(UnmanagedType.LPWStr)] string id, [MarshalAs(UnmanagedType.Bool)] bool effects, ref PropertyKey key, out PropertyValue value);
        [PreserveSig] int SetPropertyValue([MarshalAs(UnmanagedType.LPWStr)] string id, [MarshalAs(UnmanagedType.Bool)] bool effects, ref PropertyKey key, ref PropertyValue value);
    }
    public sealed class Endpoint
    {
        public string Id, Name, Description, Adapter;
        public uint State;
    }
    public static class CaptureEndpoints
    {
        [DllImport("ole32.dll")] private static extern int PropVariantClear(ref PropertyValue value);
        private static PropertyKey Name = new PropertyKey("a45c254e-df1c-4efd-8020-67d146a850e0", 14);
        private static PropertyKey Description = new PropertyKey("a45c254e-df1c-4efd-8020-67d146a850e0", 2);
        private static PropertyKey Adapter = new PropertyKey("026e516e-b814-414b-83cd-856d6fef4822", 2);
        private static void Check(int result) { Marshal.ThrowExceptionForHR(result); }
        private static void Release(object value) { if (value != null) Marshal.ReleaseComObject(value); }
        private static string Read(IPropertyStore store, PropertyKey key)
        {
            PropertyValue value;
            Check(store.GetValue(ref key, out value));
            try { return value.Type == 31 ? Marshal.PtrToStringUni(value.Text) ?? "" : ""; }
            finally { PropVariantClear(ref value); }
        }
        private static Endpoint Inspect(IDevice device)
        {
            IPropertyStore store = null;
            try {
                Check(device.OpenPropertyStore(0, out store));
                var result = new Endpoint();
                Check(device.GetId(out result.Id));
                Check(device.GetState(out result.State));
                result.Name = Read(store, Name);
                result.Description = Read(store, Description);
                result.Adapter = Read(store, Adapter);
                return result;
            } finally { Release(store); }
        }
        public static bool IsBaseCable(Endpoint endpoint)
        {
            // Only the base cable's recording endpoint. Never rename playback,
            // CABLE-A/B, Voicemeeter, physical microphones or the 16-channel pin.
            return endpoint.Id.StartsWith("{0.0.1.", StringComparison.OrdinalIgnoreCase)
                && String.Equals(endpoint.Adapter, "VB-Audio Virtual Cable", StringComparison.OrdinalIgnoreCase)
                && (String.Equals(endpoint.Description, "CABLE Output", StringComparison.OrdinalIgnoreCase)
                    || String.Equals(endpoint.Description, "PocketLink \u9ea6\u514b\u98ce", StringComparison.Ordinal));
        }
        public static Endpoint[] List()
        {
            var enumerator = (IDeviceEnumerator)new DeviceEnumerator();
            IDeviceCollection collection = null;
            try {
                Check(enumerator.EnumAudioEndpoints(1, 15, out collection)); // capture only
                uint count;
                Check(collection.GetCount(out count));
                var results = new List<Endpoint>();
                for (uint i = 0; i < count; i++) {
                    IDevice device = null;
                    try { Check(collection.Item(i, out device)); results.Add(Inspect(device)); }
                    finally { Release(device); }
                }
                return results.ToArray();
            } finally { Release(collection); Release(enumerator); }
        }
        public static void Rename(string id, string name)
        {
            var enumerator = (IDeviceEnumerator)new DeviceEnumerator();
            IDevice device = null;
            IPolicyConfig policy = null;
            try {
                Check(enumerator.GetDevice(id, out device));
                if (!IsBaseCable(Inspect(device))) throw new InvalidOperationException("Not the base VB-CABLE capture endpoint.");
                // MMDevice property stores reject endpoint name writes even with
                // administrator rights. Use audio policy; never change registry ACLs.
                policy = (IPolicyConfig)new PolicyConfigClient();
                var value = new PropertyValue { Type = 31, Text = Marshal.StringToCoTaskMemUni(name) };
                try {
                    int result = policy.SetPropertyValue(id, false, ref Description, ref value);
                    if (result < 0) throw new COMException("Windows audio policy rejected the microphone label (HRESULT 0x" + result.ToString("X8") + ").", result);
                }
                finally { PropVariantClear(ref value); }
                // FriendlyName is derived by Windows from DeviceDesc + adapter.
                // It is read-only even through policy. Wait briefly for notification
                // propagation, verifying through a fresh MMDevice property store.
                for (int attempt = 0; attempt < 10; attempt++) {
                    var updated = Inspect(device);
                    if (String.Equals(updated.Description, name, StringComparison.Ordinal)
                        && (String.Equals(updated.Name, name, StringComparison.Ordinal)
                            || String.Equals(updated.Name, name + " (" + updated.Adapter + ")", StringComparison.Ordinal))) return;
                    System.Threading.Thread.Sleep(50);
                }
                throw new InvalidOperationException("Windows did not publish the new microphone name. Refresh Sound Settings and retry.");
            } finally { Release(policy); Release(device); Release(enumerator); }
        }
    }
}
